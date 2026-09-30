<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue';
import type { Message } from './client';
import { localUrl, messageTime } from './client';
const props = defineProps<{
  message: Message;
  readonly: boolean;
  busy: boolean;
  quoted?: string;
}>();
const emit = defineEmits<{
  inspect: [];
  tap: [id: string];
  select: [id: string];
  flow: [];
  reply: [];
  react: [emoji: string];
  error: [message: string];
}>();
const p = computed(() => props.message.payload);
const interactive = computed(() => p.value.interactive || {});
const media = computed(() => p.value[props.message.type] || {});
const template = computed(() => props.message.render || {});
const listOpen = ref(false);
const blob = ref('');
const mediaBusy = ref(false);
const time = computed(() =>
  new Date(messageTime(props.message.timestamp)).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  }),
);
const text = computed(
  () =>
    p.value.text?.body ||
    interactive.value.body?.text ||
    interactive.value.button_reply?.title ||
    interactive.value.list_reply?.title ||
    interactive.value.nfm_reply?.body ||
    template.value.body?.text ||
    (typeof template.value.body === 'string' ? template.value.body : '') ||
    template.value.text ||
    p.value.template?.name ||
    '',
);
const supported = [
  'text',
  'image',
  'sticker',
  'video',
  'audio',
  'document',
  'location',
  'contacts',
  'template',
  'interactive',
  'reaction',
  'button',
];
const buttons = computed(() => interactive.value.action?.buttons || template.value.buttons || []);
async function loadMedia(download = false) {
  const raw = media.value.link || media.value.url;
  const url = raw
    ? localUrl(raw)
    : media.value.id
      ? `/v23.0/${encodeURIComponent(media.value.id)}`
      : null;
  if (!url) {
    emit('error', 'This media has no local URL or available ID.');
    return;
  }
  mediaBusy.value = true;
  try {
    let response = await fetch(url, {
      headers: { Authorization: 'Bearer wa-fake-token' },
      redirect: 'error',
    });
    if (response.headers.get('content-type')?.includes('application/json')) {
      const metadata = await response.json();
      const target = localUrl(metadata.url || '');
      if (!target) throw new Error('This media did not provide a download on the local server.');
      response = await fetch(target, {
        headers: { Authorization: 'Bearer wa-fake-token' },
        redirect: 'error',
      });
    }
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    if (blob.value) URL.revokeObjectURL(blob.value);
    blob.value = URL.createObjectURL(await response.blob());
    if (download) {
      const a = document.createElement('a');
      a.href = blob.value;
      a.download = media.value.filename || `${props.message.type}-${props.message.id}`;
      a.click();
    }
  } catch (e) {
    emit('error', e instanceof Error ? e.message : 'Could not load media.');
  } finally {
    mediaBusy.value = false;
  }
}
onBeforeUnmount(() => {
  if (blob.value) URL.revokeObjectURL(blob.value);
});
function safeLink(url: string) {
  return localUrl(url);
}
</script>
<template>
  <article
    class="message"
    :class="{ outgoing: message.direction === 'inbound', failed: message.status === 'failed' }"
  >
    <div class="bubble">
      <button
        class="message-inspect"
        :aria-label="`Inspect message ${message.id}`"
        title="Inspect message"
        @click="emit('inspect')"
      >
        ···
      </button>
      <div v-if="quoted" class="quote"><small>In reply to</small>{{ quoted }}</div>
      <div v-if="interactive.header?.text || template.header?.text" class="bubble-heading">
        {{ interactive.header?.text || template.header?.text }}
      </div>
      <template v-if="['image', 'sticker', 'video', 'audio', 'document'].includes(message.type)">
        <img
          v-if="blob && ['image', 'sticker'].includes(message.type)"
          :src="blob"
          alt="Received synthetic media"
          class="media-preview"
        />
        <video
          v-else-if="blob && message.type === 'video'"
          :src="blob"
          controls
          class="media-preview"
        />
        <audio v-else-if="blob && message.type === 'audio'" :src="blob" controls />
        <div v-else class="attachment">
          <span class="attachment-icon">{{
            message.type === 'audio' ? '♫' : message.type === 'document' ? '▤' : '▧'
          }}</span>
          <div>
            <strong>{{ media.filename || message.type }}</strong
            ><small>Local media · {{ media.mime_type || media.id || 'synthetic content' }}</small>
          </div>
        </div>
        <div class="inline-actions">
          <button v-if="message.type !== 'document'" :disabled="mediaBusy" @click="loadMedia()">
            {{ blob ? 'Reload' : 'Load media' }}</button
          ><button :disabled="mediaBusy" @click="loadMedia(true)">Download</button>
        </div>
        <p v-if="media.caption" class="message-text">{{ media.caption }}</p>
      </template>
      <template v-else-if="message.type === 'location'">
        <div class="location-grid" aria-label="Offline location illustration"><span>⌖</span></div>
        <strong>{{ p.location?.name || 'Synthetic location' }}</strong>
        <p>{{ p.location?.address }}</p>
        <small>{{ p.location?.latitude }}, {{ p.location?.longitude }}</small>
      </template>
      <template v-else-if="message.type === 'contacts'">
        <div v-for="(contact, index) in p.contacts" :key="index" class="contact-card">
          <span class="avatar tiny">{{ (contact.name?.formatted_name || 'C').slice(0, 1) }}</span>
          <div>
            <strong>{{ contact.name?.formatted_name }}</strong
            ><small v-for="phone in contact.phones" :key="phone.phone">{{ phone.phone }}</small>
          </div>
        </div>
      </template>
      <p v-else-if="message.type === 'reaction'" class="reaction-content">
        {{ p.reaction?.emoji || 'Reaction removed' }}
      </p>
      <p v-else-if="message.type === 'button'" class="message-text">
        {{ p.button?.text || p.button?.payload }}
      </p>
      <p v-else class="message-text">{{ text }}</p>
      <p v-if="interactive.footer?.text || template.footer" class="bubble-footer">
        {{ interactive.footer?.text || template.footer }}
      </p>
      <template v-if="!readonly">
        <template v-for="(button, index) in buttons" :key="button.reply?.id || button.id || index"
          ><button
            v-if="!button.type || ['reply', 'QUICK_REPLY', 'quick_reply'].includes(button.type)"
            class="bubble-action"
            :disabled="busy || message.direction !== 'outbound'"
            @click="emit('tap', button.reply?.id || button.id || String(index))"
          >
            {{ button.reply?.title || button.text || button.title }}</button
          ><button
            v-else-if="button.type === 'FLOW'"
            class="bubble-action"
            :disabled="busy"
            @click="emit('flow')"
          >
            ↗ {{ button.text }}</button
          ><a
            v-else-if="button.type === 'URL' && safeLink(button.url)"
            :href="safeLink(button.url)!"
            class="bubble-action"
            target="_blank"
            rel="noopener"
            >{{ button.text }}</a
          >
          <p v-else class="note">
            {{ button.text || button.type }} ·
            {{ button.code || button.phone_number || 'external action omitted' }}
          </p></template
        >
        <button
          v-if="interactive.type === 'list'"
          class="bubble-action"
          :disabled="busy || message.direction !== 'outbound'"
          @click="listOpen = !listOpen"
          :aria-expanded="listOpen"
        >
          ☷ {{ interactive.action?.button || 'Choose an option' }}
        </button>
        <div v-if="listOpen" class="list-options">
          <section v-for="(section, index) in interactive.action?.sections" :key="index">
            <strong>{{ section.title }}</strong
            ><button
              v-for="row in section.rows"
              :key="row.id"
              :disabled="busy"
              @click="
                emit('select', row.id);
                listOpen = false;
              "
            >
              <span>{{ row.title }}</span
              ><small>{{ row.description }}</small>
            </button>
          </section>
        </div>
        <button
          v-if="interactive.type === 'flow'"
          class="bubble-action"
          :disabled="busy || message.direction !== 'outbound'"
          @click="emit('flow')"
        >
          ↗ {{ interactive.action?.parameters?.flow_cta || 'Open form' }}
        </button>
      </template>
      <a
        v-if="interactive.type === 'cta_url' && safeLink(interactive.action?.parameters?.url)"
        class="bubble-action"
        :href="safeLink(interactive.action.parameters.url)!"
        target="_blank"
        rel="noopener"
        >{{ interactive.action.parameters.display_text || 'Open local link' }}</a
      >
      <small v-else-if="interactive.type === 'cta_url'" class="unsupported"
        >External link omitted in the local inspector.</small
      >
      <details
        v-if="
          !supported.includes(message.type) ||
          (message.type === 'interactive' &&
            ![
              'button',
              'list',
              'flow',
              'cta_url',
              'button_reply',
              'list_reply',
              'nfm_reply',
            ].includes(interactive.type))
        "
        class="unsupported"
      >
        <summary>
          Unrendered type · {{ message.type === 'interactive' ? interactive.type : message.type }}
        </summary>
        <pre>{{ JSON.stringify(p, null, 2) }}</pre>
      </details>
      <div class="bubble-meta">
        <span v-if="message.status === 'failed'" class="error-code"
          >Failure {{ p.errors?.[0]?.code || '' }}</span
        ><time>{{ time }}</time
        ><span
          v-if="message.direction === 'inbound'"
          class="ticks"
          :class="{ read: message.status === 'read' }"
          :aria-label="message.status"
          >{{
            message.status === 'read' || message.status === 'delivered'
              ? '✓✓'
              : message.status === 'failed'
                ? '!'
                : '✓'
          }}</span
        ><span v-else class="delivery-status">{{ message.status }}</span>
      </div>
    </div>
    <div v-if="!readonly" class="message-tools">
      <button aria-label="Reply with quote" title="Reply" @click="emit('reply')">↩</button
      ><button
        :disabled="busy"
        aria-label="React with thumbs up"
        title="React with thumbs up"
        @click="emit('react', '👍')"
      >
        ♡
      </button>
    </div>
  </article>
</template>
