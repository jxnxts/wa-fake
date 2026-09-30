<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import type { Json } from '../../core/src/contracts.ts';
import { SimClient, validateToken, redactEvidence, messageTime, summary } from './client';
import type { State, Message, Persona, FlowSession } from './client';
import MessageBubble from './MessageBubble.vue';
import FlowModal from './FlowModal.vue';
const state = ref<State>({
  now: Date.now(),
  users: [],
  phones: [],
  messages: [],
  templates: [],
  flows: [],
  sessions: [],
  webhooks: [],
  logs: [],
});
const loading = ref(true),
  connected = ref(false),
  busy = ref(false),
  error = ref(''),
  notice = ref('');
const userId = ref(''),
  phoneId = ref(''),
  query = ref(''),
  view = ref('client'),
  mobileChat = ref(false),
  selected = ref<Message>();
const theme = ref(localStorage.getItem('wa-fake-theme') || 'light');
const modal = ref(''),
  modalElement = ref<HTMLDialogElement>(),
  chat = ref<HTMLElement>();
const modalTitles: Record<string, string> = {
  persona: 'New persona',
  fault: 'Inject fault',
  templates: 'Template review',
  snapshots: 'Snapshots and reset',
  auth: 'Local connection',
};
const draft = ref(''),
  reply = ref<Message>(),
  composerType = ref('text');
const location = ref({ latitude: '-15.7939', longitude: '-47.8828', name: 'Synthetic location' });
const contact = ref({ name: '', phone: '' }),
  mediaId = ref('');
const personaForm = ref({ name: '', wa_id: '' });
const fault = ref({ path: '/messages', to: '', type: '', code: 131047, times: 1 });
const restoreFile = ref<HTMLInputElement>();
const tokenDraft = ref('');
const flow = ref<FlowSession>(),
  flowUser = ref(''),
  flowPreview = ref(false),
  flowError = ref('');
let client = new SimClient();
let events: EventSource | undefined;
let poll: ReturnType<typeof setInterval>;
let scheduled: ReturnType<typeof setTimeout> | undefined;
let refreshPending = false;
let refreshAgain = false;
const user = computed(() => state.value.users.find((u) => u.wa_id === userId.value));
const readonly = computed(() => view.value === 'company');
const messages = computed(() =>
  state.value.messages.filter(
    (m) =>
      m.phone_number_id === phoneId.value &&
      (m.direction === 'inbound' ? m.from === userId.value : m.to === userId.value),
  ),
);
const users = computed(() =>
  state.value.users
    .filter((u) => {
      const latest = lastMessage(u.wa_id);
      return [u.name, u.wa_id, summary(latest)]
        .join(' ')
        .toLocaleLowerCase()
        .includes(query.value.toLocaleLowerCase());
    })
    .sort(
      (a, b) =>
        messageTime(lastMessage(b.wa_id)?.timestamp || 0) -
        messageTime(lastMessage(a.wa_id)?.timestamp || 0),
    ),
);
const windowOpen = computed(() => {
  const last = [...messages.value].reverse().find((m) => m.direction === 'inbound');
  return last ? Math.max(0, 24 * 3600 * 1000 - (state.value.now - messageTime(last.timestamp))) : 0;
});
const windowLabel = computed(() =>
  windowOpen.value
    ? `Window open · ${Math.ceil(windowOpen.value / 3600000)}h remaining`
    : 'Customer service window closed',
);
const typing = computed(() => {
  const phone = state.value.phones.find((p) => p.id === phoneId.value);
  if (phone?.typing_until && phone.typing_until > state.value.now) return true;
  const raw = state.value.typing;
  const values = Array.isArray(raw) ? raw : Object.values(raw || {});
  return values.some(
    (item: any) =>
      item &&
      (item.to === userId.value || item.wa_id === userId.value) &&
      (!item.phone_number_id || item.phone_number_id === phoneId.value) &&
      Number(item.expires_at || item.until || Infinity) > state.value.now,
  );
});
function lastMessage(id: string) {
  return [...state.value.messages]
    .reverse()
    .find((m) => m.phone_number_id === phoneId.value && (m.from === id || m.to === id));
}
function initials(name: string) {
  return name
    .split(' ')
    .map((n) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}
function date(value: number | string) {
  return new Date(messageTime(value)).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'long',
  });
}
function pick(persona: Persona) {
  userId.value = persona.wa_id;
  mobileChat.value = true;
  selected.value = undefined;
  reply.value = undefined;
}
function fail(cause: unknown) {
  error.value = String(redactEvidence(cause instanceof Error ? cause.message : String(cause)));
}
async function refresh() {
  if (refreshPending) {
    refreshAgain = true;
    return;
  }
  refreshPending = true;
  try {
    state.value = await client.state();
    if (!state.value.phones.some((p) => p.id === phoneId.value))
      phoneId.value = state.value.phones[0]?.id || '';
    if (!state.value.users.some((u) => u.wa_id === userId.value))
      userId.value = state.value.users[0]?.wa_id || '';
    if (selected.value?.id)
      selected.value = state.value.messages.find((m) => m.id === selected.value?.id);
    if (flow.value && !flowPreview.value)
      flow.value = state.value.sessions.find((s) => s.id === flow.value?.id) as
        | FlowSession
        | undefined;
  } catch (e) {
    fail(e);
  } finally {
    loading.value = false;
    refreshPending = false;
    if (refreshAgain) {
      refreshAgain = false;
      scheduleRefresh();
    }
  }
}
function scheduleRefresh() {
  if (scheduled) clearTimeout(scheduled);
  scheduled = setTimeout(refresh, 70);
}
async function connect(token: string) {
  client = new SimClient(token);
  events?.close();
  connected.value = false;
  error.value = '';
  loading.value = true;
  await refresh();
  events = client.events(scheduleRefresh, (active) => {
    connected.value = active;
  });
}
async function run(action: () => Promise<unknown>, success = '') {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const result = await action();
    await refresh();
    if (success) notice.value = success;
    return result;
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}
async function addPersona() {
  await run(async () => {
    const p = await client.user(personaForm.value.wa_id, personaForm.value.name);
    userId.value = p.wa_id;
    modal.value = '';
    personaForm.value = { name: '', wa_id: '' };
  }, 'Persona created.');
}
async function send() {
  if (!user.value || !phoneId.value) return;
  let payload: Json;
  if (composerType.value === 'text') {
    if (!draft.value.trim()) return;
    payload = { type: 'text', text: { body: draft.value } };
  } else if (composerType.value === 'location')
    payload = {
      type: 'location',
      location: {
        latitude: Number(location.value.latitude),
        longitude: Number(location.value.longitude),
        name: location.value.name,
      },
    };
  else if (composerType.value === 'contacts')
    payload = {
      type: 'contacts',
      contacts: [
        {
          name: { formatted_name: contact.value.name, first_name: contact.value.name },
          phones: [{ phone: contact.value.phone }],
        },
      ],
    };
  else
    payload = {
      type: composerType.value,
      [composerType.value]: { id: mediaId.value, ...(draft.value ? { caption: draft.value } : {}) },
    };
  if (reply.value) payload.context = { message_id: reply.value.id };
  await run(async () => {
    await client.send(userId.value, phoneId.value, payload);
    draft.value = '';
    mediaId.value = '';
    reply.value = undefined;
  });
}
async function snapshot() {
  await run(async () => {
    const data = await client.snapshot();
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'wa-fake-snapshot.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'Synthetic snapshot downloaded.');
}
async function restore(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  await run(async () => {
    if (file.size > 20 * 1024 * 1024) throw new Error('Snapshot size limit: 20 MB.');
    const data = JSON.parse(await file.text());
    await client.restore(data);
    modal.value = '';
  }, 'Snapshot restored.');
  (event.target as HTMLInputElement).value = '';
}
async function injectFault() {
  const match: Json = {};
  for (const key of ['path', 'to', 'type'] as const)
    if (fault.value[key]) match[key] = fault.value[key];
  await run(async () => {
    await client.fault({
      match,
      times: Number(fault.value.times),
      error: { code: Number(fault.value.code) },
    });
    modal.value = '';
  }, 'Fault added to the engine.');
}
async function authenticate() {
  await run(async () => {
    const token = validateToken(tokenDraft.value);
    client = new SimClient(token);
    await client.state();
    sessionStorage.setItem('wa-fake-sim', token);
    await connect(token);
    tokenDraft.value = '';
    modal.value = '';
  }, 'Connected to the local Sim API.');
}
async function openFlow(message: Message) {
  await run(async () => {
    flowUser.value = userId.value;
    flowPreview.value = false;
    flowError.value = '';
    flow.value = await client.openFlow(userId.value, message.id);
  });
}
async function flowAction(action: 'fill' | 'submit' | 'back', data: Json, componentAction?: Json) {
  if (!flow.value || busy.value) return;
  busy.value = true;
  flowError.value = '';
  try {
    flow.value = await client.flow(flowUser.value, flow.value.id, action, data, componentAction);
    await refresh();
  } catch (e) {
    flowError.value = String(redactEvidence(e instanceof Error ? e.message : String(e)));
  } finally {
    busy.value = false;
  }
}
async function previewFlow(id: string) {
  await run(async () => {
    const data = await client.preview(id);
    const json = data.flow_json || data.json || data.flow || data;
    flowPreview.value = true;
    flow.value = {
      id: 'preview',
      screen: json.screens?.[0]?.id || '',
      data: {},
      flow: json,
      complete: false,
    };
  });
}
watch(modal, async (value) => {
  await nextTick();
  if (value && !modalElement.value?.open) modalElement.value?.showModal();
  else if (!value) modalElement.value?.close();
});
watch(
  theme,
  (value) => {
    document.documentElement.dataset.theme = value;
    localStorage.setItem('wa-fake-theme', value);
  },
  { immediate: true },
);
watch(
  () => messages.value.length,
  async () => {
    const nearBottom =
      !chat.value || chat.value.scrollHeight - chat.value.scrollTop - chat.value.clientHeight < 180;
    await nextTick();
    if (nearBottom) chat.value?.scrollTo({ top: chat.value.scrollHeight, behavior: 'smooth' });
  },
);
watch(userId, async () => {
  await nextTick();
  chat.value?.scrollTo({ top: chat.value.scrollHeight });
});
onMounted(async () => {
  try {
    await connect(validateToken(sessionStorage.getItem('wa-fake-sim') || 'wa-fake-sim'));
  } catch (e) {
    fail(e);
    loading.value = false;
    modal.value = 'auth';
  }
  poll = setInterval(() => {
    if (!connected.value) refresh();
  }, 5000);
  const preview = new URLSearchParams(window.location.search).get('flow');
  if (preview) await previewFlow(preview);
});
onBeforeUnmount(() => {
  events?.close();
  clearInterval(poll);
  if (scheduled) clearTimeout(scheduled);
});
</script>
<template>
  <div class="app-shell" :class="{ 'show-chat': mobileChat, 'show-inspector': selected }">
    <div class="sim-banner">
      <span class="banner-dot" /> <strong>wa-fake</strong><span>SIMULATED ENVIRONMENT</span
      ><span class="banner-detail">Synthetic data only · local</span>
    </div>
    <div v-if="error || notice" :class="error ? 'error-banner' : 'notice-banner'" role="status">
      <span>{{ error || notice }}</span
      ><button
        aria-label="Dismiss notice"
        @click="
          error = '';
          notice = '';
        "
      >
        ×
      </button>
    </div>
    <main class="workspace">
      <aside class="sidebar" aria-label="Personas and controls">
        <header class="sidebar-header">
          <div class="wordmark">
            <span class="brand-mark">w<span>·</span></span>
            <div>
              <h1>Inspector</h1>
              <small>Your conversation lab</small>
            </div>
          </div>
          <button
            class="icon-button"
            :aria-label="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
            @click="theme = theme === 'dark' ? 'light' : 'dark'"
          >
            {{ theme === 'dark' ? '☀' : '☾' }}
          </button>
        </header>
        <div class="view-switch" role="group" aria-label="Inspector view">
          <button :class="{ active: !readonly }" @click="view = 'client'">Client</button
          ><button :class="{ active: readonly }" @click="view = 'company'">
            Business <span>↗</span>
          </button>
        </div>
        <label class="phone-select"
          ><span>BUSINESS NUMBER</span
          ><select v-model="phoneId" aria-label="Business number">
            <option v-if="!state.phones.length" value="">No phone number available</option>
            <option v-for="phone in state.phones" :key="phone.id" :value="phone.id">
              {{ phone.display_phone_number }} ·
              {{ phone.registered ? 'active' : 'not registered' }}
            </option>
          </select></label
        >
        <div class="search-wrap">
          <span aria-hidden="true">⌕</span
          ><input
            v-model="query"
            type="search"
            aria-label="Search personas, numbers or messages"
            placeholder="Search conversations"
          />
        </div>
        <div class="section-label">
          <span
            >PERSONAS <b>{{ state.users.length }}</b></span
          ><button aria-label="Create persona" @click="modal = 'persona'">＋</button>
        </div>
        <nav class="personas" aria-label="Conversations">
          <p v-if="loading" class="loading">Connecting to Sim…</p>
          <div v-else-if="!users.length" class="sidebar-empty">
            <p>{{ query ? 'No matching personas.' : 'Create a persona to get started.' }}</p>
            <button v-if="!query" @click="modal = 'persona'">＋ New persona</button>
          </div>
          <button
            v-for="persona in users"
            :key="persona.wa_id"
            class="persona"
            :class="{ active: persona.wa_id === userId }"
            @click="pick(persona)"
          >
            <span class="avatar">{{ initials(persona.name) }}</span
            ><span class="persona-copy"
              ><strong
                >{{ persona.name
                }}<span v-if="persona.blocked" class="persona-tag">blocked</span></strong
              ><span>{{ summary(lastMessage(persona.wa_id)) }}</span
              ><small v-if="persona.marketing_opt_out">Marketing opted out</small></span
            ><time v-if="lastMessage(persona.wa_id)">{{
              new Date(messageTime(lastMessage(persona.wa_id)!.timestamp)).toLocaleTimeString(
                'en-US',
                { hour: '2-digit', minute: '2-digit' },
              )
            }}</time>
          </button>
        </nav>
        <footer class="tools">
          <div class="clock-label">
            <span>◷ SIMULATED CLOCK</span
            ><strong>{{
              new Date(state.now).toLocaleString('en-US', {
                day: '2-digit',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })
            }}</strong>
          </div>
          <div class="clock-actions">
            <button :disabled="busy" @click="run(() => client.clock('1h'))">+1 hour</button
            ><button :disabled="busy" @click="run(() => client.clock('24h'))">+24 hours</button>
          </div>
          <div class="tool-grid">
            <button @click="modal = 'fault'">⚑ Faults</button
            ><button @click="modal = 'templates'">▤ Templates</button
            ><button @click="modal = 'snapshots'">◫ Snapshots</button
            ><button
              @click="
                selected = messages[messages.length - 1] || ({ id: '', payload: {} } as Message);
                mobileChat = true;
              "
            >
              ⌘ Evidence
            </button>
          </div>
          <div class="connection">
            <span :class="connected ? 'online-dot' : 'offline-dot'" />{{
              connected ? 'Live · SSE' : 'Reconnecting…'
            }}<button aria-label="Configure Sim authentication" @click="modal = 'auth'">
              Configure
            </button>
          </div>
        </footer>
      </aside>
      <section class="conversation" aria-label="Selected conversation">
        <header v-if="user" class="chat-header">
          <button
            class="mobile-back icon-button"
            aria-label="Back to personas"
            @click="mobileChat = false"
          >
            ←</button
          ><span class="avatar">{{ initials(user.name) }}</span>
          <div class="chat-title">
            <h2>{{ user.name }}<span v-if="readonly" class="pill">Read-only</span></h2>
            <small>{{ typing ? 'typing…' : user.wa_id }}</small>
          </div>
          <span class="window-badge" :class="{ closed: !windowOpen }">{{ windowLabel }}</span
          ><button
            class="icon-button"
            aria-label="Refresh state"
            :disabled="loading"
            @click="refresh"
          >
            ↻
          </button>
        </header>
        <div v-if="!user" class="welcome">
          <span class="welcome-symbol">⌁</span
          ><span class="eyebrow">LOCAL. SYNTHETIC. REPRODUCIBLE.</span>
          <h2>One conversation.<br />Your entire test.</h2>
          <p>See your app’s messages, reply as a client and inspect every simulator event.</p>
          <button class="primary" @click="modal = 'persona'">
            Create your first persona <span>＋</span></button
          ><small>Graph and Sim APIs share the same engine.</small>
        </div>
        <div
          v-else
          ref="chat"
          class="chat-feed"
          role="log"
          aria-label="Conversation messages"
          aria-live="polite"
        >
          <div class="chat-context">
            {{
              readonly
                ? 'You are observing the business. Replies come from the connected application.'
                : 'You are chatting as a synthetic client.'
            }}
          </div>
          <div v-if="!messages.length" class="chat-empty">
            <h3>The conversation starts here</h3>
            <p>
              Send a message as {{ user.name }}.<br />Your application’s replies will appear live.
            </p>
          </div>
          <template v-for="(message, index) in messages" :key="message.id"
            ><div
              v-if="index === 0 || date(message.timestamp) !== date(messages[index - 1].timestamp)"
              class="date-divider"
            >
              <span>{{ date(message.timestamp) }}</span>
            </div>
            <MessageBubble
              :message="message"
              :readonly="readonly"
              :busy="busy"
              :quoted="
                message.payload.context?.message_id
                  ? summary(state.messages.find((m) => m.id === message.payload.context.message_id))
                  : undefined
              "
              @inspect="selected = message"
              @tap="(id) => run(() => client.tap(userId, message.id, id))"
              @select="(id) => run(() => client.select(userId, message.id, id))"
              @flow="openFlow(message)"
              @reply="reply = message"
              @react="(emoji) => run(() => client.react(userId, message.id, emoji))"
              @error="error = $event"
          /></template>
          <div v-if="typing" class="typing-bubble" aria-label="Business typing">● ● ●</div>
        </div>
        <div v-if="user && readonly" class="readonly-footer">
          ◉ Business view · send messages through your application’s Graph API.
        </div>
        <form v-else-if="user" class="composer" @submit.prevent="send">
          <div v-if="reply" class="reply-preview">
            <span><small>Replying to</small>{{ summary(reply) }}</span
            ><button type="button" aria-label="Cancel quoted reply" @click="reply = undefined">
              ×
            </button>
          </div>
          <div class="composer-fields" v-if="composerType === 'location'">
            <label
              >Latitude<input
                v-model="location.latitude"
                type="number"
                step="any"
                min="-90"
                max="90"
                required /></label
            ><label
              >Longitude<input
                v-model="location.longitude"
                type="number"
                step="any"
                min="-180"
                max="180"
                required /></label
            ><label>Name<input v-model="location.name" required /></label>
          </div>
          <div class="composer-fields" v-else-if="composerType === 'contacts'">
            <label>Contact name<input v-model="contact.name" required /></label
            ><label
              >Synthetic phone number<input v-model="contact.phone" required pattern="[+0-9]+"
            /></label>
          </div>
          <div class="composer-fields" v-else-if="composerType !== 'text'">
            <label
              >ID of media already uploaded to Graph<input
                v-model="mediaId"
                required
                placeholder="media_…"
            /></label>
          </div>
          <div class="composer-row">
            <select v-model="composerType" aria-label="Message type">
              <option value="text">Text</option>
              <option value="image">Image</option>
              <option value="audio">Audio</option>
              <option value="video">Video</option>
              <option value="document">Document</option>
              <option value="location">Location</option>
              <option value="contacts">Contact</option></select
            ><textarea
              v-if="!['location', 'contacts'].includes(composerType)"
              v-model="draft"
              :aria-label="composerType === 'text' ? 'Client message' : 'Media caption'"
              :placeholder="
                composerType === 'text' ? 'Type as ' + user.name + '…' : 'Optional caption…'
              "
              :required="composerType === 'text'"
              rows="1"
              @keydown.enter.exact.prevent="send"
            /><span v-else class="composer-hint">Synthetic data</span
            ><button
              class="send-button"
              :disabled="busy || !phoneId"
              aria-label="Send message as client"
            >
              {{ busy ? '…' : '➤' }}
            </button>
          </div>
          <small class="composer-footnote">Enter sends · Shift+Enter adds a line · Sim API</small>
        </form>
      </section>
      <aside v-if="selected" class="inspector-panel" aria-label="Inspection and evidence">
        <header>
          <div>
            <small>LOCAL DEBUGGING</small>
            <h2>Evidence</h2>
          </div>
          <button class="icon-button" aria-label="Close evidence" @click="selected = undefined">
            ×
          </button>
        </header>
        <div class="inspector-content">
          <template v-if="selected.id"
            ><div class="inspect-label">SELECTED MESSAGE</div>
            <code class="message-id">{{ selected.id }}</code>
            <dl>
              <dt>Direction</dt>
              <dd>
                {{ selected.direction === 'inbound' ? 'Client → business' : 'Business → client' }}
              </dd>
              <dt>Type</dt>
              <dd>{{ selected.type }}</dd>
              <dt>Status</dt>
              <dd>{{ selected.status }}</dd>
              <dt>Phone</dt>
              <dd>{{ selected.phone_number_id }}</dd>
            </dl>
            <details>
              <summary>Synthetic wire · redacted</summary>
              <pre>{{ JSON.stringify(redactEvidence(selected.payload), null, 2) }}</pre>
            </details></template
          >
          <div class="inspect-label">RECENT ENGINE EVIDENCE</div>
          <p class="note">
            Content and credentials are redacted. Recent events are shown; correlation depends on
            recorded IDs.
          </p>
          <button :disabled="busy" @click="run(() => client.drain(), 'Webhook queue processed.')">
            Drain webhook queue
          </button>
          <div v-if="!state.webhooks.length" class="note">No webhooks recorded.</div>
          <details
            v-for="(webhook, index) in [...state.webhooks].reverse().slice(0, 20)"
            :key="webhook.id || index"
          >
            <summary>
              Webhook · {{ webhook.field || webhook.status || 'event'
              }}<span class="event-time"
                >{{
                  Array.isArray(webhook.attempts)
                    ? webhook.attempts.length
                    : Number(webhook.attempts || 0)
                }}
                attempts</span
              >
            </summary>
            <pre>{{ JSON.stringify(redactEvidence(webhook), null, 2) }}</pre>
            <button
              v-if="webhook.id"
              :disabled="busy"
              @click="run(() => client.redeliver(webhook.id), 'Webhook queued again.')"
            >
              ↻ Redeliver
            </button>
          </details>
          <div class="inspect-label">GRAPH / SIM · REDACTED LOG</div>
          <div v-if="!state.logs.length" class="note">No API calls recorded.</div>
          <details
            v-for="(log, index) in [...state.logs].reverse().slice(0, 30)"
            :key="log.id || index"
          >
            <summary>
              {{ log.method || log.action || log.type || log.event || 'Event' }} {{ log.path || ''
              }}<span class="event-time">{{ log.status || '' }}</span>
            </summary>
            <pre>{{ JSON.stringify(redactEvidence(log), null, 2) }}</pre>
          </details>
        </div>
      </aside>
    </main>
    <dialog
      ref="modalElement"
      class="control-dialog"
      aria-label="Simulation controls"
      @close="modal = ''"
      @cancel="modal = ''"
    >
      <header class="modal-header">
        <div>
          <small>SIMULATOR CONTROLS</small>
          <h2>{{ modalTitles[modal] }}</h2>
        </div>
        <button aria-label="Close controls" @click="modal = ''">×</button>
      </header>
      <div class="modal-body">
        <p v-if="error" role="alert" class="error-banner">{{ error }}</p>
        <form v-if="modal === 'persona'" @submit.prevent="addPersona">
          <p class="note">Create a synthetic client. All fields stay local.</p>
          <label class="field"
            >Name<input
              v-model="personaForm.name"
              required
              maxlength="80"
              autofocus
              placeholder="Example: Ana Test" /></label
          ><label class="field"
            >Synthetic number (wa_id)<input
              v-model="personaForm.wa_id"
              required
              pattern="[0-9]{6,20}"
              inputmode="numeric"
              placeholder="5511900000001" /></label
          ><button class="primary" :disabled="busy">Create persona</button>
        </form>
        <form v-if="modal === 'fault'" @submit.prevent="injectFault">
          <p class="note">
            The engine will apply this error to upcoming calls matching the filters.
          </p>
          <label class="field"
            >Path contains<input v-model="fault.path" placeholder="/messages" /></label
          ><label class="field"
            >Recipient (optional)<input v-model="fault.to" placeholder="wa_id" /></label
          ><label class="field"
            >Type (optional)<input v-model="fault.type" placeholder="text, template…"
          /></label>
          <div class="two-fields">
            <label class="field"
              >Graph code<input v-model="fault.code" type="number" min="1" required /></label
            ><label class="field"
              >Occurrences<input v-model="fault.times" type="number" min="1" max="100" required
            /></label>
          </div>
          <button class="primary" :disabled="busy">Inject fault</button>
        </form>
        <div v-if="modal === 'templates'">
          <p v-if="!state.templates.length" class="note">
            No templates. Create templates through your application’s Graph API.
          </p>
          <article v-for="template in state.templates" :key="template.id" class="template-review">
            <strong>{{ template.name }}</strong
            ><small>{{ template.language }} · {{ template.category }}</small
            ><span class="pill">{{ template.status }}</span>
            <div class="inline-actions">
              <button
                :disabled="busy || template.status === 'APPROVED'"
                @click="run(() => client.review(template.id, 'APPROVED'))"
              >
                ✓ Approve</button
              ><button
                :disabled="busy || template.status === 'REJECTED'"
                @click="run(() => client.review(template.id, 'REJECTED'))"
              >
                × Reject
              </button>
            </div>
          </article>
          <div v-if="state.flows.length" class="inspect-label">FLOWS · READ-ONLY PREVIEW</div>
          <button
            v-for="item in state.flows"
            :key="item.id"
            class="flow-preview-button"
            :disabled="busy"
            @click="
              modal = '';
              previewFlow(item.id);
            "
          >
            {{ item.name || item.id }} <span>↗</span>
          </button>
        </div>
        <div v-if="modal === 'snapshots'" class="snapshot-controls">
          <p class="note">
            Snapshots include state and synthetic conversation content. Restore replaces the current
            state.
          </p>
          <button :disabled="busy" @click="snapshot">↓ Download snapshot JSON</button
          ><button :disabled="busy" @click="restoreFile?.click()">↑ Restore JSON file</button
          ><input
            ref="restoreFile"
            type="file"
            accept="application/json,.json"
            class="visually-hidden"
            aria-label="Snapshot file"
            @change="restore"
          />
          <hr />
          <p class="note">Reset removes this instance’s personas, messages and configuration.</p>
          <button
            class="danger"
            :disabled="busy"
            @click="
              run(async () => {
                await client.reset();
                modal = '';
              }, 'Instance reset.')
            "
          >
            Reset local state
          </button>
        </div>
        <form v-if="modal === 'auth'" @submit.prevent="authenticate">
          <p class="note">
            Synthetic Sim API credential. Stored only in this session; production tokens are
            refused.
          </p>
          <label class="field"
            >Sim token<input
              v-model="tokenDraft"
              type="password"
              autocomplete="off"
              spellcheck="false"
              placeholder="wa-fake-sim"
              required /></label
          ><button class="primary" :disabled="busy">Connect</button
          ><button
            type="button"
            :disabled="busy"
            @click="
              tokenDraft = 'wa-fake-sim';
              authenticate();
            "
          >
            Use local default
          </button>
        </form>
      </div>
    </dialog>
    <FlowModal
      v-if="flow"
      :session="flow"
      :busy="busy"
      :preview="flowPreview"
      :error="flowError"
      @close="flow = undefined"
      @action="flowAction"
    />
  </div>
</template>
