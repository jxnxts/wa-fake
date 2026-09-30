import { createHash } from 'node:crypto';
import type { EngineHost, GraphExtension, Json, RouteContext } from '../../core/src/contracts.ts';
import { mimeMatches } from '../../core/src/media.ts';

const categories = ['MARKETING', 'UTILITY', 'AUTHENTICATION'];
const statuses = ['PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED'];
const clone = <T>(value: T): T => structuredClone(value);
const object = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const length = (value: string) => [...value].length;

async function input(ctx: RouteContext): Promise<Json> {
  const result: Json = Object.fromEntries(new URL(ctx.request.url).searchParams);
  if (ctx.method !== 'GET' && ctx.method !== 'DELETE') {
    const kind = ctx.request.headers.get('content-type') ?? '';
    if (kind.includes('application/json')) Object.assign(result, await ctx.request.json());
    else if (kind.includes('form'))
      Object.assign(result, Object.fromEntries(await ctx.request.formData()));
    for (const key of ['components'])
      if (typeof result[key] === 'string') {
        try {
          result[key] = JSON.parse(result[key]);
        } catch {
          throw ctx.engine.graphError(100, `${key} must be JSON`);
        }
      }
  }
  return result;
}

export function createTemplates(engine: EngineHost): GraphExtension {
  engine.store.templates ??= {};
  const templates = () => engine.store.templates as Record<string, Json>;
  const error = (message: string, code = 100, status = 400, subcode?: number): never => {
    throw engine.graphError(code, message, status, subcode);
  };
  const unsupported = (message: string): never => error(`not_implemented: ${message}`, 100, 501);
  const get = (id: string): Json =>
    Object.hasOwn(templates(), id) ? templates()[id]! : error('Unknown message template', 100, 404);
  const templateId = () =>
    String(
      4000000000000000n +
        (BigInt(
          '0x' + createHash('sha256').update(engine.id('template')).digest('hex').slice(0, 13),
        ) %
          1000000000000000n),
    );
  function waba(id: string): void {
    if (
      !(engine.store.wabas && Object.hasOwn(engine.store.wabas, id)) &&
      !Object.values(engine.store.phones ?? {}).some((p: any) => p.waba_id === id)
    )
      error('Unknown WhatsApp Business Account', 100, 404);
  }
  function text(value: unknown, max: number, field: string, required = true, code = 100): string {
    if (typeof value !== 'string' || (required && !value.trim()) || length(value) > max)
      error(`${field} must contain ${required ? '1' : '0'}-${max} characters`, code);
    return value as string;
  }
  function variables(value: string, format: string): string[] {
    const vars = [...value.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((m) => m[1]!);
    const stripped = value.replace(/{{\s*([^{}]+?)\s*}}/g, '');
    if (stripped.includes('{{') || stripped.includes('}}')) error('Malformed template placeholder');
    const unique = [...new Set(vars)];
    if (format === 'POSITIONAL') {
      if (unique.some((v) => !/^[1-9]\d*$/.test(v)))
        error('POSITIONAL parameters must use numeric placeholders');
      const numbers = unique.map(Number).sort((a, b) => a - b);
      if (numbers.some((v, i) => v !== i + 1))
        error('Positional parameters must be sequential starting at 1');
      return numbers.map(String);
    }
    if (unique.some((v) => !/^[a-z][a-z0-9_]*$/.test(v)))
      error('NAMED parameters must use lowercase names');
    return unique;
  }
  function examples(component: Json, vars: string[], format: string): void {
    if (!vars.length) return;
    const ex = component.example;
    if (!object(ex)) error(`${component.type} parameter examples are required`);
    const field = component.type === 'HEADER' ? 'header_text' : 'body_text';
    if (format === 'NAMED') {
      const values = ex[`${field}_named_params`];
      if (
        !Array.isArray(values) ||
        values.length !== vars.length ||
        vars.some(
          (name) =>
            !values.some(
              (v) =>
                object(v) &&
                v.param_name === name &&
                typeof v.example === 'string' &&
                v.example.length,
            ),
        )
      )
        error(`${field}_named_params must provide one example per named parameter`);
    } else {
      const rows = component.type === 'HEADER' ? [ex[field]] : ex[field];
      if (
        !Array.isArray(rows) ||
        !rows.length ||
        rows.some(
          (row) =>
            !Array.isArray(row) ||
            row.length !== vars.length ||
            row.some((v) => typeof v !== 'string' || !v.length),
        )
      )
        error(`${field} must provide examples matching the placeholders`);
    }
  }
  function validate(raw: Json): Json {
    const name = text(raw.name, 512, 'name');
    if (!/^[a-z0-9_]+$/.test(name))
      error('Template name must contain lowercase letters, numbers and underscores');
    const language = text(raw.language, 16, 'language');
    if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)) error('Invalid template language');
    if (!categories.includes(raw.category))
      error('category must be MARKETING, UTILITY or AUTHENTICATION');
    const format = raw.parameter_format ?? 'POSITIONAL';
    if (!['POSITIONAL', 'NAMED'].includes(format)) error('Invalid parameter_format');
    if (!Array.isArray(raw.components) || !raw.components.length)
      error('components must be a nonempty array');
    const components: Json[] = clone(raw.components);
    const seen = new Set<string>();
    for (const c of components) {
      if (!object(c)) error('Every component must be an object');
      if (typeof c.type === 'string') c.type = c.type.toUpperCase();
      if (!['HEADER', 'BODY', 'FOOTER', 'BUTTONS'].includes(c.type))
        unsupported(`template component ${String(c.type)}`);
      if (seen.has(c.type)) error(`Duplicate ${c.type} component`);
      seen.add(c.type);
      if (c.type === 'HEADER') {
        c.format ??= 'TEXT';
        if (!['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'].includes(c.format))
          unsupported(`template header ${c.format}`);
        if (c.format === 'TEXT') {
          const vars = variables(text(c.text, 60, 'HEADER text'), format);
          if (vars.length > 1) error('Text header supports at most one parameter');
          examples(c, vars, format);
        } else if (
          c.format !== 'LOCATION' &&
          (!Array.isArray(c.example?.header_handle) ||
            !c.example.header_handle.length ||
            c.example.header_handle.some((v: unknown) => typeof v !== 'string' || !v))
        )
          error('Media header example.header_handle is required');
      }
      if (c.type === 'BODY' && raw.category !== 'AUTHENTICATION')
        examples(c, variables(text(c.text, 1024, 'BODY text'), format), format);
      if (c.type === 'FOOTER') {
        if (raw.category === 'AUTHENTICATION') {
          if (
            !Number.isInteger(c.code_expiration_minutes) ||
            c.code_expiration_minutes < 1 ||
            c.code_expiration_minutes > 90
          )
            error('code_expiration_minutes must be 1-90');
        } else if (variables(text(c.text, 60, 'FOOTER text'), format).length)
          error('FOOTER does not support parameters');
      }
      if (c.type === 'BUTTONS') {
        if (!Array.isArray(c.buttons) || !c.buttons.length || c.buttons.length > 10)
          error('BUTTONS must contain 1-10 buttons');
        let urls = 0,
          phones = 0;
        for (const b of c.buttons) {
          if (!object(b)) error('Every button must be an object');
          if (!['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'OTP', 'COPY_CODE', 'FLOW'].includes(b.type))
            unsupported(`template button ${String(b.type)}`);
          if (b.type === 'OTP') {
            if (raw.category !== 'AUTHENTICATION')
              error('OTP buttons require AUTHENTICATION category');
            if (!['COPY_CODE', 'ONE_TAP'].includes(b.otp_type))
              unsupported(`OTP type ${b.otp_type}`);
            b.text ??= 'Copy code';
            if (
              b.otp_type === 'ONE_TAP' &&
              (typeof b.package_name !== 'string' ||
                typeof b.signature_hash !== 'string' ||
                b.autofill_text == null)
            )
              error('ONE_TAP requires package_name, signature_hash and autofill_text');
          }
          text(b.text, 25, 'button text');
          if (b.type === 'URL') {
            if (++urls > 2) error('At most two URL buttons are allowed');
            const url = text(b.url, 2000, 'button URL');
            if (!/^https?:\/\//.test(url)) error('URL button must use HTTP(S)');
            const vars = variables(url, format);
            if (vars.length > 1 || (vars.length && !/{{[^{}]+}}$/.test(url)))
              error('URL supports one dynamic suffix parameter');
            if (
              vars.length &&
              (!Array.isArray(b.example) ||
                !b.example.length ||
                b.example.some((v: unknown) => typeof v !== 'string' || !v))
            )
              error('Dynamic URL button requires example');
          }
          if (b.type === 'PHONE_NUMBER') {
            if (++phones > 1 || !/^\+?\d{5,20}$/.test(b.phone_number))
              error('Invalid phone button or more than one phone button');
          }
          if (b.type === 'COPY_CODE' && (!Array.isArray(b.example) || !b.example.length))
            error('COPY_CODE requires example');
          if (b.type === 'FLOW') {
            if (b.flow_json !== undefined)
              unsupported('inline template Flow JSON; create a Flow resource first');
            if (
              !!b.flow_id === !!b.flow_name ||
              !['navigate', 'data_exchange'].includes(b.flow_action ?? 'navigate')
            )
              error('FLOW button requires exactly one flow_id or flow_name and valid flow_action');
            if (
              (b.flow_id !== undefined && typeof b.flow_id !== 'string') ||
              (b.flow_name !== undefined && typeof b.flow_name !== 'string')
            )
              error('Flow reference must be a string');
            const flow = b.flow_id
              ? Object.hasOwn(engine.store.flows, b.flow_id)
                ? engine.store.flows[b.flow_id]
                : undefined
              : Object.values(engine.store.flows ?? {}).find(
                  (flow: Json) => flow.name === b.flow_name && flow.waba_id === raw.waba_id,
                );
            if (!flow || flow.waba_id !== raw.waba_id) error('Unknown Flow in template WABA');
            if (
              b.navigate_screen &&
              !flow!.json?.screens.some((screen: Json) => screen.id === b.navigate_screen)
            )
              error('Unknown template Flow navigate_screen');
            b.flow_id = flow!.id;
            delete b.flow_name;
          }
        }
        const types = c.buttons.map((b: Json) => b.type);
        const first = types.indexOf('QUICK_REPLY'),
          last = types.lastIndexOf('QUICK_REPLY');
        if (first >= 0 && types.slice(first, last + 1).some((t: string) => t !== 'QUICK_REPLY'))
          error('Quick reply buttons must be grouped together');
      }
    }
    if (!seen.has('BODY')) error('BODY component is required');
    if (raw.category === 'AUTHENTICATION') {
      if (format !== 'POSITIONAL' || seen.has('HEADER'))
        error('Authentication templates require POSITIONAL format and no HEADER');
      const body = components.find((c) => c.type === 'BODY')!;
      if (body.text !== undefined)
        error('Authentication BODY text is generated and cannot be supplied');
      const buttons = components.find((c) => c.type === 'BUTTONS')?.buttons;
      if (!Array.isArray(buttons) || buttons.length !== 1 || buttons[0].type !== 'OTP')
        error('Authentication templates require one OTP button');
    }
    return { name, language, category: raw.category, parameter_format: format, components };
  }
  function unique(value: Json, exclude?: string): void {
    if (
      Object.values(templates()).some(
        (t) =>
          t.id !== exclude &&
          t.waba_id === value.waba_id &&
          t.name === value.name &&
          t.language === value.language,
      )
    )
      error('A template with this name and language already exists', 100, 400, 2388024);
  }
  async function review(t: Json, status: string, reason = 'NONE'): Promise<void> {
    const transitions: Record<string, string[]> = {
      PENDING: ['APPROVED', 'REJECTED'],
      APPROVED: ['PAUSED', 'DISABLED'],
      PAUSED: ['APPROVED', 'DISABLED'],
      REJECTED: [],
      DISABLED: [],
    };
    if (!statuses.includes(status) || !transitions[t.status]?.includes(status))
      error(`Invalid template transition ${t.status} -> ${status}`);
    const phone =
      Object.values(engine.store.phones).find((phone) => phone.waba_id === t.waba_id) ??
      unsupported('template status webhook for WABA without a local phone');
    t.status = status;
    t.rejected_reason = status === 'REJECTED' ? reason : undefined;
    t.updated_at = engine.now();
    await engine.enqueueWebhook(
      'message_template_status_update',
      {
        event: status,
        message_template_id: t.id,
        message_template_name: t.name,
        message_template_language: t.language,
        reason,
      },
      phone.id,
    );
    engine.emit('template.status', { id: t.id, status });
  }
  function project(t: Json, fields?: string): Json {
    const defaultFields = [
      'id',
      'name',
      'language',
      'status',
      'category',
      'components',
      'parameter_format',
    ];
    const keys = fields ? fields.split(',') : defaultFields;
    for (const key of keys)
      if (![...defaultFields, 'quality_score', 'rejected_reason'].includes(key))
        unsupported(`template field ${key}`);
    return Object.fromEntries(
      keys.map((key) => [key, t[key] ?? (key === 'quality_score' ? { score: 'UNKNOWN' } : null)]),
    );
  }
  async function parameters(
    def: Json,
    supplied: Json[],
    format: string,
    auth = false,
    phoneId?: string,
  ): Promise<Json> {
    if (!Array.isArray(supplied)) error('Template parameters must be an array', 132000);
    const textDef = auth ? '{{1}}' : (def.text ?? '');
    const vars = variables(textDef, format);
    if (def.type === 'HEADER' && def.format !== 'TEXT') {
      const kind = def.format.toLowerCase();
      if (supplied.length !== 1) error('Template header parameter count mismatch', 132000);
      const p = supplied[0]!;
      if (!object(p) || p.type !== kind || !object(p[kind]))
        error('Template header parameter format mismatch', 132012);
      if (kind === 'location') {
        if (typeof p.location.latitude !== 'number' || typeof p.location.longitude !== 'number')
          error('Location header requires coordinates', 132012);
      } else {
        if (!p[kind].id && !p[kind].link) error('Media header requires id or link', 132012);
        if (p[kind].id) {
          const media = engine.store.media?.[p[kind].id];
          if (!media || media.phone_number_id !== phoneId || !mimeMatches(kind, media.mime_type))
            error('Unknown, unowned or incompatible template header media', 132012);
        }
        if (p[kind].link) await engine.assertLocalUrl(p[kind].link);
      }
      return { format: def.format, media: clone(p[kind]) };
    }
    if (supplied.length !== vars.length) error('Template parameter count mismatch', 132000);
    if (supplied.some((p) => !object(p))) error('Template parameters must be objects', 132012);
    if (format === 'POSITIONAL' && supplied.some((p) => p.parameter_name !== undefined))
      error('Positional parameters cannot supply parameter_name', 132012);
    if (
      format === 'NAMED' &&
      (new Set(supplied.map((p) => p.parameter_name)).size !== vars.length ||
        vars.some((v) => !supplied.some((p) => p.parameter_name === v)))
    )
      error('Named template parameter names mismatch', 132000);
    const values: Record<string, string> = {};
    for (let i = 0; i < vars.length; i++) {
      const p =
        format === 'NAMED' ? supplied.find((p) => p.parameter_name === vars[i])! : supplied[i]!;
      if (!['text', 'currency', 'date_time'].includes(p.type))
        error('Template parameter type mismatch', 132012);
      if ((def.type === 'HEADER' || def.parameterType === 'text' || auth) && p.type !== 'text')
        error('Component requires text parameter', 132012);
      let value: string;
      if (p.type === 'text')
        value = text(p.text, def.type === 'HEADER' ? 60 : 1024, 'parameter text', false, 132012);
      else if (p.type === 'currency') {
        if (
          !object(p.currency) ||
          typeof p.currency.fallback_value !== 'string' ||
          !/^[A-Z]{3}$/.test(p.currency.code) ||
          !Number.isInteger(p.currency.amount_1000)
        )
          error('Invalid currency parameter', 132012);
        value = p.currency.fallback_value;
      } else {
        if (!object(p.date_time) || typeof p.date_time.fallback_value !== 'string')
          error('Invalid date_time parameter', 132012);
        value = p.date_time.fallback_value;
      }
      values[vars[i]!] = value!;
    }
    const rendered = textDef.replace(
      /{{\s*([^{}]+?)\s*}}/g,
      (_: string, key: string) => values[key] ?? '',
    );
    if (length(rendered) > (def.type === 'HEADER' ? 60 : (def.limit ?? 1024)))
      error('Rendered template exceeds component limit', 132012);
    return {
      text: auth
        ? `${rendered} is your verification code.${def.add_security_recommendation ? ' For your security, do not share this code.' : ''}`
        : rendered,
      values,
    };
  }
  return {
    async graph(ctx) {
      if (ctx.edge === 'message_templates') {
        waba(ctx.id);
        const body = await input(ctx);
        if (ctx.method === 'POST') {
          const t: Json = {
            ...validate({ ...body, waba_id: ctx.id }),
            id: templateId(),
            waba_id: ctx.id,
            status: 'PENDING',
            created_at: engine.now(),
            updated_at: engine.now(),
          };
          unique(t);
          templates()[t.id] = t;
          engine.emit('template.created', { id: t.id });
          return Response.json({ id: t.id, status: t.status, category: t.category });
        }
        if (ctx.method === 'GET') {
          let values = Object.values(templates()).filter((t) => t.waba_id === ctx.id);
          for (const key of ['name', 'language', 'status', 'category'])
            if (body[key]) values = values.filter((t) => t[key] === body[key]);
          const limit = body.limit == null ? 25 : Number(body.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) error('limit must be 1-100');
          let start = 0;
          if (body.after) {
            const index = values.findIndex((t) => t.id === body.after);
            if (index < 0) error('Invalid after cursor');
            start = index + 1;
          }
          if (body.before) {
            const index = values.findIndex((t) => t.id === body.before);
            if (index < 0) error('Invalid before cursor');
            start = Math.max(0, index - limit);
          }
          const page = values.slice(start, start + limit),
            paging: Json = { cursors: { before: page[0]?.id ?? '', after: page.at(-1)?.id ?? '' } };
          if (start + limit < values.length) {
            const url = new URL(ctx.request.url);
            url.searchParams.delete('before');
            url.searchParams.set('after', page.at(-1)!.id);
            paging.next = url.toString();
          }
          if (start > 0) {
            const url = new URL(ctx.request.url);
            url.searchParams.delete('after');
            url.searchParams.set('before', page[0]!.id);
            paging.previous = url.toString();
          }
          return Response.json({ data: page.map((t) => project(t, body.fields)), paging });
        }
        if (ctx.method === 'DELETE') {
          if (!body.name && !body.hsm_id) error('name or hsm_id is required');
          const matches = Object.values(templates()).filter(
            (t) =>
              t.waba_id === ctx.id &&
              (!body.name || t.name === body.name) &&
              (!body.hsm_id || t.id === body.hsm_id),
          );
          if (!matches.length) error('Unknown message template', 100, 404);
          for (const t of matches) delete templates()[t.id];
          engine.emit('template.deleted', { ids: matches.map((t) => t.id) });
          return Response.json({ success: true });
        }
        return unsupported(`message_templates ${ctx.method}`);
      }
      if (!Object.hasOwn(templates(), ctx.id)) return null;
      if (ctx.edge) return unsupported(`template edge ${ctx.edge}`);
      const t = get(ctx.id),
        body = await input(ctx);
      if (ctx.method === 'GET') return Response.json(project(t, body.fields));
      if (ctx.method === 'POST') {
        if (body.name || body.language) error('Template name and language are immutable');
        if (t.status === 'DISABLED') error('Disabled template cannot be edited');
        const next: Json = {
          ...t,
          ...validate({ ...t, ...body }),
          updated_at: engine.now(),
          status: 'PENDING',
        };
        const categoryPhone =
          next.category !== t.category
            ? (Object.values(engine.store.phones).find((phone) => phone.waba_id === t.waba_id) ??
              unsupported('template category webhook for WABA without a local phone'))
            : undefined;
        unique(next, t.id);
        templates()[t.id] = next;
        if (next.category !== t.category) {
          await engine.enqueueWebhook(
            'template_category_update',
            {
              message_template_id: t.id,
              message_template_name: t.name,
              message_template_language: t.language,
              previous_category: t.category,
              new_category: next.category,
            },
            categoryPhone!.id,
          );
        }
        engine.emit('template.updated', { id: t.id });
        return Response.json({ success: true });
      }
      if (ctx.method === 'DELETE') {
        delete templates()[t.id];
        engine.emit('template.deleted', { ids: [t.id] });
        return Response.json({ success: true });
      }
      return unsupported(`template ${ctx.method}`);
    },
    async sim(ctx) {
      const match = ctx.path.match(/^\/_wa\/templates\/([^/]+)\/review$/);
      if (!match) return null;
      if (ctx.method !== 'POST') return unsupported('template review method');
      const body = await input(ctx),
        t = get(decodeURIComponent(match[1]!));
      await review(t, body.status, body.reason);
      return Response.json(project(t));
    },
    async validateMessage(payload, phone) {
      if (payload.type !== 'template') return undefined;
      const wire = payload.template;
      if (!object(wire) || typeof wire.name !== 'string' || typeof wire.language?.code !== 'string')
        error('template.name and language.code are required');
      const t = Object.values(templates()).find(
        (t) =>
          t.waba_id === phone.waba_id && t.name === wire.name && t.language === wire.language.code,
      );
      if (!t || t.status !== 'APPROVED')
        error('Template does not exist in this language or is not approved', 132001);
      const supplied: Json[] = wire.components ?? [];
      if (!Array.isArray(supplied)) error('Template components must be an array', 132012);
      const byKey = new Map<string, Json>();
      for (const c of supplied) {
        if (!object(c) || !['header', 'body', 'button'].includes(c.type))
          error('Template component type mismatch', 132012);
        const key = c.type === 'button' ? `button:${c.index}` : c.type;
        if (byKey.has(key)) error('Duplicate send component', 132000);
        byKey.set(key, c);
      }
      const render: Json = {
        type: 'template',
        template_id: t!.id,
        name: t!.name,
        category: t!.category,
        language: t!.language,
        buttons: [],
      };
      for (const def of t!.components) {
        if (def.type === 'HEADER' || def.type === 'BODY') {
          const key = def.type.toLowerCase(),
            params = byKey.get(key)?.parameters ?? [];
          render[key] = await parameters(
            def,
            params,
            t!.parameter_format,
            t!.category === 'AUTHENTICATION' && def.type === 'BODY',
            phone.id,
          );
          byKey.delete(key);
        } else if (def.type === 'FOOTER')
          render.footer =
            t!.category === 'AUTHENTICATION'
              ? `This code expires in ${def.code_expiration_minutes} minutes.`
              : def.text;
        else
          for (let index = 0; index < def.buttons.length; index++) {
            const b = def.buttons[index],
              key = `button:${index}`,
              c = byKey.get(key),
              params: Json[] = c?.parameters ?? [];
            const expected = b.type === 'OTP' ? 'url' : b.type.toLowerCase();
            if (c && c.sub_type !== expected) error('Template button subtype mismatch', 132012);
            if (!Array.isArray(params)) error('Button parameters must be an array', 132000);
            const out: Json = { ...b, index };
            if (b.type === 'QUICK_REPLY') {
              if (params.length > 1) error('Quick reply parameter count mismatch', 132000);
              if (
                params.length &&
                (!object(params[0]) ||
                  params[0]!.type !== 'payload' ||
                  typeof params[0]!.payload !== 'string')
              )
                error('Quick reply requires payload parameter', 132012);
              out.payload = params[0]?.payload ?? b.text;
            } else if (b.type === 'URL') {
              const value = await parameters(
                { type: 'BODY', text: b.url, limit: 2000, parameterType: 'text' },
                params,
                t!.parameter_format,
              );
              out.url = value.text;
            } else if (b.type === 'OTP') {
              if (params.length !== 1) error('OTP button requires one code parameter', 132000);
              if (
                !object(params[0]) ||
                params[0]!.type !== 'text' ||
                typeof params[0]!.text !== 'string'
              )
                error('OTP requires text parameter', 132012);
              out.code = params[0]!.text;
              const bodyParam = supplied.find((component) => component.type === 'body')
                ?.parameters?.[0];
              if (bodyParam?.text !== out.code)
                error('OTP body and button codes must match', 132012);
            } else if (b.type === 'COPY_CODE') {
              if (params.length !== 1) error('Copy code requires one parameter', 132000);
              if (
                !object(params[0]) ||
                params[0]!.type !== 'coupon_code' ||
                typeof params[0]!.coupon_code !== 'string'
              )
                error('Copy code requires coupon_code', 132012);
              out.code = params[0]!.coupon_code;
            } else if (b.type === 'FLOW') {
              if (
                params.length > 1 ||
                (params.length && (!object(params[0]) || params[0]!.type !== 'action'))
              )
                error('FLOW requires action parameter', 132012);
              if (
                params.length &&
                (!object(params[0]!.action) ||
                  (params[0]!.action.flow_token !== undefined &&
                    typeof params[0]!.action.flow_token !== 'string') ||
                  (params[0]!.action.flow_action_data !== undefined &&
                    !object(params[0]!.action.flow_action_data)))
              )
                error('Invalid FLOW action parameter', 132012);
              const flow = Object.hasOwn(engine.store.flows, b.flow_id)
                ? engine.store.flows[b.flow_id]
                : undefined;
              if (!flow || flow.waba_id !== phone.waba_id || flow.status !== 'PUBLISHED')
                error('Template Flow is missing or not published', 132001);
              out.action = params[0]?.action ?? {};
            } else if (params.length) error('Static button has no parameters', 132000);
            render.buttons.push(out);
            byKey.delete(key);
          }
      }
      if (byKey.size)
        error('Template send contains unexpected components or button indices', 132000);
      return render;
    },
  };
}
