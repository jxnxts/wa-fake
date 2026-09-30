<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { FlowScreen } from 'flowso/vue';
import 'flowso/vue/theme.css';
import type { Json } from '../../core/src/contracts.ts';
import type { FlowSession } from './client';
import { redactEvidence } from './client';
const props = defineProps<{
  session: FlowSession;
  busy: boolean;
  preview?: boolean;
  error?: string;
}>();
const emit = defineEmits<{
  close: [];
  action: [action: 'fill' | 'submit' | 'back', data: Json, componentAction?: Json];
}>();
const dialog = ref<HTMLDialogElement>();
const values = ref<Json>({});
let inputTimer: ReturnType<typeof setTimeout> | undefined;
const rendered = computed(() => {
  const raw = props.session.renderedScreen || props.session.render;
  if (!raw) return null;
  const copy = JSON.parse(JSON.stringify(raw));
  for (const node of copy.children || []) {
    if (node.name && values.value[node.name] !== undefined) node.value = values.value[node.name];
    if (
      node.type === 'Image' &&
      typeof node.props.src === 'string' &&
      !/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(node.props.src)
    )
      node.props.src = '';
  }
  return copy;
});
function visibleValues() {
  const names = new Set(
    (rendered.value?.children || []).map((node: Json) => node.name).filter(Boolean),
  );
  return Object.fromEntries(Object.entries(values.value).filter(([key]) => names.has(key)));
}
function rendererInput(name: string, value: unknown) {
  values.value[name] = value ?? '';
  if (inputTimer) clearTimeout(inputTimer);
  inputTimer = setTimeout(() => {
    inputTimer = undefined;
    emit('action', 'fill', visibleValues());
  }, 300);
}
function rendererAction(action: Json) {
  if (inputTimer) clearTimeout(inputTimer);
  inputTimer = undefined;
  emit('action', 'submit', visibleValues(), action);
}
const screen = computed(
  () =>
    props.session.flow?.screens?.find((s: Json) => s.id === props.session.screen) ||
    props.session.screen_definition ||
    {},
);
function resolve(value: any): any {
  if (typeof value !== 'string') return value;
  const match = value.match(/^\$\{(data|form)\.([^}]+)\}$/);
  return match ? (match[1] === 'data' ? props.session.data : values.value)?.[match[2]] : value;
}
function flatten(items: Json[]): Json[] {
  return (items || []).flatMap((item) => {
    if (item.type === 'Form') return flatten(item.children);
    if (item.type === 'If')
      return flatten(resolve(item.condition) === true ? item.then : item.else);
    if (item.type === 'Switch')
      return flatten(item.cases?.[String(resolve(item.value))] || item.default);
    return [item];
  });
}
const components = computed(() => flatten(screen.value.layout?.children || []));
const footer = computed(() => components.value.find((c: Json) => c.type === 'Footer'));
const recognized = [
  'TextHeading',
  'TextSubheading',
  'TextBody',
  'TextCaption',
  'TextInput',
  'TextArea',
  'Dropdown',
  'RadioButtonsGroup',
  'CheckboxGroup',
  'DatePicker',
  'OptIn',
  'Footer',
  'Image',
];
const unknown = computed(() => components.value.filter((c: Json) => !recognized.includes(c.type)));
function options(c: Json): Json[] {
  const result = resolve(c['data-source']);
  return Array.isArray(result) ? result : [];
}
function inputType(c: Json) {
  return (
    (
      { email: 'email', number: 'number', password: 'password', phone: 'tel' } as Record<
        string,
        string
      >
    )[c['input-type']] || 'text'
  );
}
watch(
  () => props.session,
  () => {
    if (inputTimer) return;
    values.value = { ...(props.session.values || {}), ...(props.session.form_data || {}) };
    if (!props.session.render && !props.session.renderedScreen)
      for (const field of components.value)
        if (field.name && values.value[field.name] === undefined)
          values.value[field.name] =
            resolve(field['init-value']) ??
            (field.type === 'CheckboxGroup' ? [] : field.type === 'OptIn' ? false : '');
  },
  { immediate: true },
);
onMounted(() => dialog.value?.showModal());
onBeforeUnmount(() => {
  if (inputTimer) clearTimeout(inputTimer);
});
</script>
<template>
  <dialog
    ref="dialog"
    class="flow-dialog"
    aria-label="Simulated Flow form"
    @close="emit('close')"
    @cancel="emit('close')"
  >
    <header class="modal-header">
      <div>
        <small>SIMULATED FORM {{ preview ? '· PREVIEW' : '' }}</small>
        <h2>{{ screen.title || session.screen || 'Flow' }}</h2>
      </div>
      <button aria-label="Close form" @click="dialog?.close()">×</button>
    </header>
    <div v-if="session.complete" class="empty-state">
      <span class="success-icon">✓</span>
      <h3>Form completed</h3>
      <p>The result was recorded by the Sim engine.</p>
      <button class="primary" @click="dialog?.close()">Back to conversation</button>
    </div>
    <div v-else-if="rendered && !preview" class="flowso-body wa-flow">
      <p v-if="error" role="alert" class="error-banner">{{ error }}</p>
      <FlowScreen
        :screen="rendered"
        :loading="busy"
        @input="rendererInput"
        @action="rendererAction"
      />
      <div class="flow-back">
        <button type="button" :disabled="busy" @click="emit('action', 'back', {})">← Back</button>
      </div>
      <details class="flow-evidence">
        <summary>Session and data · redacted</summary>
        <pre>{{
          JSON.stringify(
            redactEvidence({
              id: session.id,
              screen: session.screen,
              data: session.data,
              values: session.values,
              errors: session.errors,
            }),
            null,
            2,
          )
        }}</pre>
      </details>
    </div>
    <form v-else class="flow-body" @submit.prevent="emit('action', 'submit', values)">
      <p v-if="error" role="alert" class="error-banner">{{ error }}</p>
      <template v-for="(c, index) in components" :key="session.screen + '-' + index">
        <h2 v-if="c.type === 'TextHeading'">{{ resolve(c.text) }}</h2>
        <h3 v-else-if="c.type === 'TextSubheading'">{{ resolve(c.text) }}</h3>
        <p
          v-else-if="['TextBody', 'TextCaption'].includes(c.type)"
          :class="{ muted: c.type === 'TextCaption' }"
        >
          {{ resolve(c.text) }}
        </p>
        <label v-else-if="c.type === 'TextInput'" class="field"
          >{{ resolve(c.label)
          }}<input
            v-model="values[c.name]"
            :type="inputType(c)"
            :required="c.required === true"
            :disabled="busy || preview || c.enabled === false"
            :minlength="c['min-chars']"
            :maxlength="c['max-chars']"
          /><small>{{ resolve(c['helper-text']) }}</small></label
        >
        <label v-else-if="c.type === 'TextArea'" class="field"
          >{{ resolve(c.label)
          }}<textarea
            v-model="values[c.name]"
            :required="c.required === true"
            :disabled="busy || preview"
            :maxlength="c['max-length']"
          />
        </label>
        <label v-else-if="c.type === 'DatePicker'" class="field"
          >{{ resolve(c.label)
          }}<input
            v-model="values[c.name]"
            type="date"
            :required="c.required === true"
            :disabled="busy || preview"
            :min="resolve(c['min-date'])"
            :max="resolve(c['max-date'])"
        /></label>
        <label v-else-if="c.type === 'Dropdown'" class="field"
          >{{ resolve(c.label)
          }}<select
            v-model="values[c.name]"
            :required="c.required === true"
            :disabled="busy || preview"
          >
            <option value="" disabled>Select an option</option>
            <option v-for="option in options(c)" :key="option.id" :value="option.id">
              {{ option.title }}
            </option>
          </select></label
        >
        <fieldset v-else-if="['RadioButtonsGroup', 'CheckboxGroup'].includes(c.type)">
          <legend>{{ resolve(c.label) }}</legend>
          <label v-for="option in options(c)" :key="option.id" class="choice"
            ><input
              v-model="values[c.name]"
              :type="c.type === 'CheckboxGroup' ? 'checkbox' : 'radio'"
              :name="c.name"
              :value="option.id"
              :required="c.type === 'RadioButtonsGroup' && c.required === true"
              :disabled="busy || preview"
            />{{ option.title }}<small>{{ option.description }}</small></label
          >
        </fieldset>
        <label v-else-if="c.type === 'OptIn'" class="choice"
          ><input
            v-model="values[c.name]"
            type="checkbox"
            :required="c.required === true"
            :disabled="busy || preview"
          />{{ resolve(c.label) }}</label
        >
        <p v-else-if="c.type === 'Image'" class="note">
          Embedded image omitted in this native rendering.
        </p>
        <p v-else-if="c.type !== 'Footer'" class="note">
          Unsupported visual component: {{ c.type }}
        </p>
      </template>
      <p v-if="!components.length" class="note">This session did not provide screen components.</p>
      <div v-if="!preview" class="flow-actions">
        <button type="button" :disabled="busy" @click="emit('action', 'back', values)">
          ← Back</button
        ><button type="button" :disabled="busy" @click="emit('action', 'fill', values)">
          Save fields</button
        ><button class="primary" :disabled="busy || unknown.length > 0 || !components.length">
          {{ busy ? 'Processing…' : resolve(footer?.label) || 'Continue' }}
        </button>
      </div>
      <details class="flow-evidence">
        <summary>Session and data · redacted</summary>
        <pre>{{
          JSON.stringify(
            redactEvidence({
              id: session.id,
              screen: session.screen,
              data: session.data,
              fields: session.fields,
              history: session.history,
            }),
            null,
            2,
          )
        }}</pre>
      </details>
    </form>
  </dialog>
</template>
