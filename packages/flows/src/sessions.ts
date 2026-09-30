import { createFlowRuntime, type FlowRuntime } from 'flowso/runtime';
import { isDeepStrictEqual } from 'node:util';
import type { EngineHost, Json } from '../../core/src/contracts.ts';
import { createEncryptedEndpoint, FlowEndpointError } from './endpoint.ts';
import { checkScreenData, isObject } from './validation.ts';

export function createSessionController(engine: EngineHost, getFlow: (id: string) => Json) {
  const active = new Map<
    string,
    { record: Json; runtime: FlowRuntime; failure?: FlowEndpointError }
  >();
  const queues = new Map<string, Promise<unknown>>();
  const error = (message: string, code = 100, status = 400): never => {
    throw engine.graphError(code, message, status);
  };
  const records = () => engine.store.sessions as Record<string, Json>;

  function serialize(record: Json, runtime: FlowRuntime): Json {
    const state = runtime.getState(),
      rendered = runtime.render();
    record.runtime_state = structuredClone({ ...state, events: [] });
    Object.assign(record, {
      screen: state.screenId,
      data: state.screenData[state.screenId ?? ''] ?? {},
      complete: state.status === 'completed',
      fields: rendered?.children ?? [],
      values: state.formValues[state.screenId ?? ''] ?? {},
      errors: state.fieldErrors[state.screenId ?? ''] ?? {},
      status: state.status,
      renderedScreen: rendered,
      render: rendered,
    });
    if (state.completion) record.result = JSON.parse(state.completion.responseJson);
    engine.emit('flow.session', {
      id: record.id,
      flow_id: record.flow_id,
      screen: record.screen,
      status: record.status,
    });
    return publicSession(record);
  }
  function publicSession(record: Json): Json {
    // Synthetic application data belongs in authenticated state, never in event/log payloads.
    return structuredClone(
      Object.fromEntries(
        Object.entries(record).filter(([key]) => !['runtime_state', 'flow_token'].includes(key)),
      ),
    );
  }
  async function makeRuntime(
    record: Json,
  ): Promise<{ record: Json; runtime: FlowRuntime; failure?: FlowEndpointError }> {
    const flow = getFlow(record.flow_id);
    const transport = createEncryptedEndpoint(engine, flow, record.phone_number_id);
    const handle: { record: Json; runtime: FlowRuntime; failure?: FlowEndpointError } = {
      record,
      runtime: null as any,
    };
    handle.runtime = createFlowRuntime({
      flow: record.flow as any,
      flowToken: record.flow_token,
      useExamples: false,
      strictRouting: true,
      endpoint: {
        async exchange(request) {
          try {
            const response = await transport.exchange(request);
            try {
              // Current official Node examples omit version; an explicit mismatched version still fails.
              if (
                (response.version !== undefined && response.version !== request.version) ||
                !isObject(response.data)
              )
                throw new Error();
              if (response.screen === 'SUCCESS') {
                const params = response.data.extension_message_response?.params;
                if (!isObject(params) || params.flow_token !== record.flow_token) throw new Error();
              } else if (typeof response.screen === 'string')
                checkScreenData(record.flow, response.screen, response.data);
              else throw new Error();
            } catch {
              await transport.notification(request, 'invalid_response');
              throw new FlowEndpointError('invalid_response');
            }
            return response as any;
          } catch (cause) {
            handle.failure =
              cause instanceof FlowEndpointError
                ? cause
                : new FlowEndpointError('invalid_response');
            throw handle.failure;
          }
        },
      },
    });
    if (record.runtime_state?.screenId) {
      await handle.runtime.start({
        mode: 'navigate',
        screen: record.runtime_state.screenId,
        data: record.runtime_state.screenData[record.runtime_state.screenId] ?? {},
      });
      // flowso 0.1.0 exposes live state but no importState; persist and restore its public state.
      Object.assign(handle.runtime.getState(), structuredClone(record.runtime_state));
    }
    active.set(record.id, handle);
    return handle;
  }
  async function use(id: string, user: string) {
    const record = Object.hasOwn(records(), id)
      ? records()[id]!
      : error('Unknown Flow session', 100, 404);
    if (record.wa_id !== user) error('Flow session belongs to another user', 100, 403);
    if (record.complete || record.closed) error('Flow session is already closed');
    const cached = active.get(id);
    const handle = cached?.record === record ? cached : await makeRuntime(record);
    handle.failure = undefined;
    return handle;
  }
  function assertHealthy(handle: {
    record: Json;
    runtime: FlowRuntime;
    failure?: FlowEndpointError;
  }): void {
    const state = handle.runtime.getState();
    if (handle.failure) {
      if (handle.failure.kind === 'flow_token') {
        handle.record.closed = true;
        handle.record.status = 'closed';
      }
      const code =
        handle.failure.kind === 'flow_token'
          ? 427
          : handle.failure.kind === 'signature'
            ? 432
            : handle.failure.kind === 'decrypt'
              ? 421
              : 100;
      const status = handle.failure.kind === 'timeout' ? 504 : code === 100 ? 502 : 400;
      error(handle.failure.message, code, status);
    }
    if (state.status === 'error')
      error(
        `Flow runtime ${state.error?.kind ?? 'error'}`,
        100,
        state.error?.kind === 'invalid_action' ? 501 : 400,
      );
    if (handle.runtime.render()?.errorMessage?.startsWith('Expression error:'))
      error('Flow expression could not be evaluated', 100, 501);
  }
  async function finalize(record: Json, runtime: FlowRuntime): Promise<Json> {
    serialize(record, runtime);
    const state = runtime.getState();
    if (state.status === 'completed' && !record.nfm_reply) {
      record.nfm_reply = await engine.receiveMessage(
        record.wa_id,
        {
          type: 'interactive',
          context: { message_id: record.message_id },
          interactive: {
            type: 'nfm_reply',
            nfm_reply: {
              response_json: state.completion!.responseJson,
              body: 'Sent',
              name: 'flow',
            },
          },
        },
        record.phone_number_id,
      );
    }
    return publicSession(record);
  }
  async function fillHandle(
    handle: { record: Json; runtime: FlowRuntime; failure?: FlowEndpointError },
    data: unknown,
  ): Promise<void> {
    if (!isObject(data)) error('Flow fill data must be an object');
    for (const [name, value] of Object.entries(data as Json)) {
      const node = handle.runtime.render()?.children.find((node) => node.name === name);
      if (!node) error(`Unknown or invisible Flow field ${name}`);
      if (node!.props.enabled === false) error(`Flow field ${name} is disabled`);
      if (
        ['TextInput', 'TextArea', 'Dropdown', 'RadioButtonsGroup'].includes(node!.type) &&
        typeof value !== 'string'
      )
        error(`Flow field ${name} requires a string`);
      if (node!.type === 'OptIn' && typeof value !== 'boolean')
        error(`Flow field ${name} requires a boolean`);
      if (
        ['CheckboxGroup', 'ChipsSelector'].includes(node!.type) &&
        (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
      )
        error(`Flow field ${name} requires string IDs`);
      if (
        ['DatePicker', 'CalendarPicker'].includes(node!.type) &&
        !(typeof value === 'string' || typeof value === 'number' || isObject(value))
      )
        error(`Flow field ${name} requires a date`);
      await handle.runtime.setFormValue(name, value);
      serialize(handle.record, handle.runtime);
      assertHealthy(handle);
    }
  }
  async function locked<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    queues.set(id, next);
    try {
      return await next;
    } finally {
      if (queues.get(id) === next) queues.delete(id);
    }
  }
  return {
    async open(user: string, body: Json): Promise<Json> {
      if (!engine.store.users[user]) error('Unknown user', 100, 404);
      const message = (engine.store.messages as Json[]).find(
        (message) => message.id === body.message_id,
      );
      if (!message || message.direction !== 'outbound' || message.to !== user)
        error('Flow message not found for this user', 100, 404);
      let parameters: Json = message!.payload?.interactive?.action?.parameters;
      if (message!.type === 'template') {
        const buttons: Json[] = message!.render?.buttons ?? [];
        const button = buttons.find(
          (button) => button.type === 'FLOW' && (!body.flow_id || button.flow_id === body.flow_id),
        );
        if (!button) error('Template has no matching Flow button');
        parameters = {
          flow_id: button!.flow_id,
          flow_name: button!.flow_name,
          flow_action: button!.flow_action ?? 'navigate',
          flow_token: button!.action?.flow_token,
          flow_action_payload: {
            screen: button!.navigate_screen,
            data: button!.action?.flow_action_data ?? {},
          },
        };
      }
      if (!isObject(parameters)) error('Message is not a Flow');
      const phone = engine.store.phones[message!.phone_number_id];
      const flow = parameters!.flow_id
        ? getFlow(parameters!.flow_id)
        : (Object.values(engine.store.flows).find(
            (flow: any) => flow.name === parameters!.flow_name && flow.waba_id === phone.waba_id,
          ) as Json);
      if (!flow || flow.waba_id !== phone.waba_id || (body.flow_id && body.flow_id !== flow.id))
        error('Flow is not owned by the message sender');
      const mode = parameters!.mode ?? 'published';
      if (mode === 'draft' ? flow.status !== 'DRAFT' : flow.status !== 'PUBLISHED')
        error('Flow is not available in the requested mode');
      if (!flow.json || flow.validation_errors?.length) error('Flow JSON is missing or invalid');
      const record: Json = {
        id: engine.id('session'),
        flow_id: flow.id,
        flow: structuredClone(flow.json),
        wa_id: user,
        phone_number_id: message!.phone_number_id,
        message_id: message!.id,
        flow_token: body.flow_token ?? parameters!.flow_token ?? engine.id('flow_token'),
        complete: false,
        created_at: engine.now(),
      };
      if (typeof record.flow_token !== 'string' || !record.flow_token.length)
        error('flow_token must be a nonempty string');
      records()[record.id] = record;
      const handle = await makeRuntime(record);
      if (parameters!.flow_action === 'data_exchange')
        await handle.runtime.start({ mode: 'data_exchange' });
      else {
        const screen = parameters!.flow_action_payload?.screen ?? record.flow.screens[0]?.id;
        const data = parameters!.flow_action_payload?.data ?? {};
        try {
          checkScreenData(record.flow, screen, data);
        } catch {
          error('Navigate payload does not match screen data');
        }
        await handle.runtime.start({ mode: 'navigate', screen, data });
      }
      serialize(record, handle.runtime);
      assertHealthy(handle);
      return finalize(record, handle.runtime);
    },
    async act(user: string, id: string, action: string, body: Json): Promise<Json> {
      return locked(id, async () => {
        const handle = await use(id, user);
        if (action === 'fill') await fillHandle(handle, body.data ?? {});
        else if (action === 'submit') {
          if (body.data !== undefined) await fillHandle(handle, body.data);
          const rendered = handle.runtime.render();
          const node = body.action
            ? rendered?.children.find((node) =>
                isDeepStrictEqual(node.props['on-click-action'], body.action),
              )
            : rendered?.children.find((node) => node.type === 'Footer');
          if (!node)
            error(
              body.action
                ? 'Action does not belong to a visible component'
                : 'not_implemented: submit without a Footer action',
              100,
              body.action ? 400 : 501,
            );
          if (node!.props.enabled === false) error('Flow submit is disabled');
          if (
            node!.props['on-click-action'] &&
            (node!.props['on-click-action'] as Json).name === 'open_url'
          )
            error('not_implemented: Flow open_url action', 100, 501);
          await handle.runtime.dispatch(node!.props['on-click-action'] as any, {
            validate: node!.type === 'Footer',
          });
        } else if (action === 'back') {
          if (handle.runtime.getState().history.length < 2) error('No previous Flow screen');
          await handle.runtime.back();
        } else error('not_implemented: Flow session action', 100, 501);
        serialize(handle.record, handle.runtime);
        assertHealthy(handle);
        return finalize(handle.record, handle.runtime);
      });
    },
  };
}
