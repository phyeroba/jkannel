<script setup lang="ts">
/**
 * EVERY SMSC SETTING, POINT AND CLICK.
 *
 * THE PROBLEM THIS SOLVES
 * ---------------------------------------------------------------------------
 * Plain Kannel is configured by editing `kannel.conf`: every directive is in
 * one documented file that a text editor can reach. This console promised to
 * replace that, and then exposed four fields — protocol, host, port, TPS — out
 * of the thirty-eight the API accepts and the generator renders.
 *
 * That is strictly worse than the file it replaced. An operator handed a
 * carrier's onboarding sheet (system type, address range, TON/NPI, window size,
 * enquire-link interval) could read every value off it and set none of them,
 * and their only remaining route was curl. `configurability-audit.mjs` measured
 * it: 32 of 38 settable fields had no control.
 *
 * WHY THIS IS EASIER THAN THE CONFIG FILE, NOT JUST EQUAL TO IT
 * ---------------------------------------------------------------------------
 * Exposing thirty-eight inputs at once would be more daunting, not less. So:
 *
 *  - ONLY WHAT APPLIES. A `fake` SMSC has no system-id and an HTTP one has no
 *    bind mode. The file cannot do this — it lists every directive whether it
 *    applies or not, and answering "does this one apply to me" is most of the
 *    work of reading it.
 *  - THE CARRIER'S OWN ORDER. The groups match how an onboarding sheet is laid
 *    out, so an operator works down the sheet rather than searching a manual.
 *  - COLLAPSED UNTIL WANTED. A working SMPP bind needs the first two groups.
 *    Everything else is an override, and an override that is not set renders
 *    nothing — so the engine's own default applies, which is the behaviour
 *    somebody gets from an unset directive in the file.
 *  - THE DIRECTIVE IS NAMED. Every field states the `kannel.conf` directive it
 *    becomes, so somebody who knows the file finds what they know, and somebody
 *    who does not can search the Kannel manual for the exact word.
 *  - PLACEHOLDERS ARE THE ENGINE'S DEFAULTS, never prefilled values. Typing a
 *    number that happens to equal the default would pin it into the rendered
 *    config; leaving it blank leaves the directive out. Those are different
 *    things and the form must not blur them.
 *
 * WHERE IT DELIBERATELY DIVERGES FROM THE KIT
 * ---------------------------------------------------------------------------
 * `SmscsScreen.jsx` shows a plain "Password" box. This form cannot: the API
 * rejects a literal password and stores only a `secret://` reference, because a
 * bind credential must not live in the console's database. The form therefore
 * asks for the reference AND resolves it live — naming the environment variable
 * it derives to and saying whether that variable is set. That derivation lived
 * only in the backend, so an operator previously invented a reference, saved
 * it, and discovered which variable they needed by reading a failed bind.
 */
import { computed, ref, watch } from 'vue';
import { apiRequest } from '../api';

/** The subset of an SMSC record this form reads and writes. */
export type SmscDraft = Record<string, unknown>;

const props = defineProps<{
  modelValue: SmscDraft;
  /** Create hides nothing; edit keeps the engine id fixed. */
  mode: 'create' | 'edit';
  testid?: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [SmscDraft] }>();

const draft = computed(() => props.modelValue);
function set(key: string, value: unknown) {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}
/** `<input type="number">` yields '' when cleared; that must mean "unset". */
function setNumber(key: string, raw: string) {
  set(key, raw === '' ? null : Number(raw));
}
const str = (key: string) => (draft.value[key] == null ? '' : String(draft.value[key]));
const bool = (key: string) => Boolean(draft.value[key]);

const type = computed(() => String(draft.value.type ?? 'smpp'));
const isSmpp = computed(() => type.value === 'smpp');
const isHttp = computed(() => type.value === 'http');
/** A `fake` SMSC is bearerbox listening on a port; it has no carrier at all. */
const isFake = computed(() => type.value === 'fake');

/** Sections past the essentials, each closed until the operator wants it. */
const open = ref<Record<string, boolean>>({
  addressing: false,
  throughput: false,
  routing: false,
});
function toggle(section: string) {
  open.value = { ...open.value, [section]: !open.value[section] };
}

/**
 * A routing list is stored as an array and typed as the engine's own
 * semicolon-separated string, so a value can be pasted straight from a
 * carrier's instructions without being re-punctuated.
 */
function listValue(key: string): string {
  const value = draft.value[key];
  return Array.isArray(value) ? value.join(';') : typeof value === 'string' ? value : '';
}
function setList(key: string, raw: string) {
  const entries = raw
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  // An explicitly emptied box clears the rule; the API distinguishes an empty
  // array from an omitted key and so must this.
  set(key, entries);
}

// --- Secret references ------------------------------------------------------
type SecretStatus = { reference: string; envName: string | null; present: boolean; valid: boolean };
const secretStatus = ref<Record<string, SecretStatus>>({});
const secretError = ref('');

/**
 * Asks the API which environment variable each reference derives to and whether
 * it is set. Debounced, because it runs while the operator is still typing.
 */
let secretTimer: ReturnType<typeof setTimeout> | undefined;
async function checkSecrets() {
  const references = [str('credentialSecretRef'), str('usernameSecretRef')].filter(Boolean);
  if (!references.length) {
    secretStatus.value = {};
    return;
  }
  try {
    const result = await apiRequest<{ references: SecretStatus[] }>(
      '/configurations/secret-check',
      { method: 'POST', body: JSON.stringify({ references }) },
    );
    secretStatus.value = Object.fromEntries(result.references.map((r) => [r.reference, r]));
    secretError.value = '';
  } catch (cause) {
    // A failed check must not block saving: it is an aid, not a gate. Say so
    // rather than leaving the field looking unverified for no stated reason.
    secretStatus.value = {};
    secretError.value =
      cause instanceof Error ? cause.message : 'The secret check could not be run.';
  }
}
watch(
  () => [str('credentialSecretRef'), str('usernameSecretRef')].join('|'),
  () => {
    clearTimeout(secretTimer);
    secretTimer = setTimeout(() => void checkSecrets(), 400);
  },
  { immediate: true },
);
function statusOf(key: string): SecretStatus | undefined {
  const reference = str(key);
  return reference ? secretStatus.value[reference] : undefined;
}

const id = (suffix: string) => `${props.testid ?? 'smsc-form'}-${suffix}`;
</script>

<template>
  <div class="smsc-form" :data-testid="testid ?? 'smsc-form'">
    <!-- IDENTITY & PROTOCOL ------------------------------------------------
         What this connection is, and which of the engine's four drivers runs
         it. The driver choice decides which of the groups below apply, so it
         comes first. -->
    <fieldset class="cfg-group">
      <legend>Identity</legend>
      <div class="dialog-grid">
        <label class="field">
          <span>Name</span>
          <input
            :value="str('name')"
            :data-testid="id('name')"
            @input="set('name', ($event.target as HTMLInputElement).value)"
          />
          <small>What operators call it. Free text.</small>
        </label>
        <label class="field">
          <span>Engine id</span>
          <input
            :value="str('engineId')"
            :disabled="mode === 'edit'"
            placeholder="mtn-ug-trx1"
            :data-testid="id('engineId')"
            @input="set('engineId', ($event.target as HTMLInputElement).value)"
          />
          <small>
            <span class="mono">smsc-id</span> — lowercase, and permanent. Routes and reports
            reference it{{ mode === 'edit' ? ', so it cannot be changed' : '' }}.
          </small>
        </label>
        <label class="field">
          <span>Protocol</span>
          <select
            :value="type"
            :data-testid="id('type')"
            @change="set('type', ($event.target as HTMLSelectElement).value)"
          >
            <option value="smpp">SMPP — a carrier bind</option>
            <option value="http">HTTP — an aggregator API</option>
            <option value="at">AT — a GSM modem</option>
            <option value="fake">Fake — a local test sink</option>
          </select>
          <small><span class="mono">smsc</span> — decides which settings below apply.</small>
        </label>
        <label class="field checkbox-row">
          <input
            type="checkbox"
            :checked="bool('enabled')"
            :data-testid="id('enabled')"
            @change="set('enabled', ($event.target as HTMLInputElement).checked)"
          />
          <span>Include in the generated configuration</span>
        </label>
      </div>
    </fieldset>

    <!-- CONNECTION ---------------------------------------------------------- -->
    <fieldset class="cfg-group">
      <legend>{{ isFake ? 'Listener' : 'Connection' }}</legend>
      <p v-if="isFake" class="source-note">
        A fake SMSC is bearerbox <em>listening</em> on a port for a
        <span class="mono">fakesmsc</span> client. It reaches no carrier and delivers nothing; it
        exists so throughput and routing can be exercised without a real bind.
      </p>
      <div class="dialog-grid">
        <label v-if="!isFake" class="field">
          <span>Host</span>
          <input
            :value="str('host')"
            placeholder="smpp.carrier.co.ug"
            :data-testid="id('host')"
            @input="set('host', ($event.target as HTMLInputElement).value)"
          />
          <small><span class="mono">host</span></small>
        </label>
        <label class="field">
          <span>Port</span>
          <input
            type="number"
            min="1"
            max="65535"
            :value="str('port')"
            :placeholder="isSmpp ? '2775' : ''"
            :data-testid="id('port')"
            @input="setNumber('port', ($event.target as HTMLInputElement).value)"
          />
          <small><span class="mono">port</span></small>
        </label>
        <label v-if="isSmpp" class="field">
          <span>Bind mode</span>
          <select
            :value="str('bindMode')"
            :data-testid="id('bindMode')"
            @change="set('bindMode', ($event.target as HTMLSelectElement).value || null)"
          >
            <option value="">transceiver (default)</option>
            <option value="transceiver">transceiver</option>
            <option value="transmitter">transmitter — send only</option>
            <option value="receiver">receiver — deliver only</option>
          </select>
          <small>
            A transmitter cannot receive. Split binds need a second connection and a
            <span class="mono">receive-port</span>.
          </small>
        </label>
        <label v-if="isSmpp && str('bindMode') === 'transmitter'" class="field">
          <span>Receive port</span>
          <input
            type="number"
            min="1"
            max="65535"
            :value="str('receivePort')"
            :data-testid="id('receivePort')"
            @input="setNumber('receivePort', ($event.target as HTMLInputElement).value)"
          />
          <small><span class="mono">receive-port</span> — the carrier's receiver port.</small>
        </label>
        <label v-if="isHttp" class="field dialog-span">
          <span>Send URL</span>
          <input
            :value="str('sendUrl')"
            placeholder="https://api.aggregator.com/send"
            :data-testid="id('sendUrl')"
            @input="set('sendUrl', ($event.target as HTMLInputElement).value)"
          />
          <small><span class="mono">send-url</span></small>
        </label>
        <label v-if="isSmpp" class="field checkbox-row">
          <input
            type="checkbox"
            :checked="bool('useTls')"
            :data-testid="id('useTls')"
            @change="set('useTls', ($event.target as HTMLInputElement).checked)"
          />
          <span>TLS (<span class="mono">use-ssl</span>)</span>
        </label>
      </div>
    </fieldset>

    <!-- CREDENTIALS ---------------------------------------------------------
         The one place this form cannot mirror the kit, and the reason is a
         security property rather than an omission. -->
    <fieldset v-if="!isFake" class="cfg-group">
      <legend>Credentials</legend>
      <p class="source-note">
        Passwords are never stored here. The record holds a
        <span class="mono">secret://</span> reference; the rendered configuration holds the
        environment variable it derives to, and the value is read from the deployment environment at
        generation time.
      </p>
      <div class="dialog-grid">
        <label v-if="isSmpp" class="field">
          <span>System id</span>
          <input
            :value="str('systemId')"
            placeholder="issued by the carrier"
            :data-testid="id('systemId')"
            @input="set('systemId', ($event.target as HTMLInputElement).value)"
          />
          <small><span class="mono">smsc-username</span> — the bind username, in clear.</small>
        </label>
        <!-- System type belongs here, with the rest of the bind identity, and
             it used to live under "Addressing and encoding" — a group that is
             COLLAPSED by default and whose note says every field in it is
             optional. It is not optional: bearerbox refuses to construct an
             SMPP connection without it and then panics rather than skipping it,
             so one carrier saved with this blank stops the entire gateway,
             including SMSCs that have nothing to do with it. That is how the
             local engine ended up in a restart loop. Required, visible, and
             next to the two fields an operator copies off the same sheet. -->
        <label v-if="isSmpp" class="field">
          <span>System type <em class="req">required</em></span>
          <input
            :value="str('systemType')"
            placeholder="issued by the carrier — e.g. SMPP, VMA"
            :data-testid="id('systemType')"
            :aria-invalid="isSmpp && !str('systemType').trim() ? 'true' : undefined"
            @input="set('systemType', ($event.target as HTMLInputElement).value)"
          />
          <small v-if="isSmpp && !str('systemType').trim()" class="req-note">
            <span class="mono">system-type</span> — required for SMPP. Left blank, bearerbox
            panics on startup and every other SMSC goes down with it.
          </small>
          <small v-else><span class="mono">system-type</span> — part of the bind, set by the carrier.</small>
        </label>
        <label class="field">
          <span>Username reference (optional)</span>
          <input
            :value="str('usernameSecretRef')"
            placeholder="secret://carrier/mtn-ug-user"
            :data-testid="id('usernameSecretRef')"
            @input="set('usernameSecretRef', ($event.target as HTMLInputElement).value)"
          />
          <small>
            Use instead of System id when the carrier treats the username as sensitive.
          </small>
        </label>
        <label class="field dialog-span">
          <span>Password reference</span>
          <input
            :value="str('credentialSecretRef')"
            placeholder="secret://carrier/mtn-ug-password"
            :data-testid="id('credentialSecretRef')"
            @input="set('credentialSecretRef', ($event.target as HTMLInputElement).value)"
          />
          <small><span class="mono">smsc-password</span></small>
        </label>
      </div>

      <!-- The derivation, made visible. This is the step that used to be
           invisible: the operator invented a reference and had no way to learn
           which environment variable they now had to set. -->
      <template v-for="key in ['credentialSecretRef', 'usernameSecretRef']" :key="key">
        <p v-if="statusOf(key)" class="secret-status" :data-testid="id(`${key}-status`)">
          <template v-if="!statusOf(key)!.valid">
            <span class="status-badge warn">not a reference yet</span>
            Must look like <span class="mono">secret://namespace/name</span>.
          </template>
          <template v-else-if="statusOf(key)!.present">
            <span class="status-badge good">set</span>
            Reads <span class="mono">{{ statusOf(key)!.envName }}</span> from the deployment
            environment.
          </template>
          <template v-else>
            <span class="status-badge bad">not set</span>
            Nothing named <span class="mono">{{ statusOf(key)!.envName }}</span> exists in the
            deployment environment. Generation will refuse, or the bind will fail to authenticate.
            Set that variable and redeploy the engine.
          </template>
        </p>
      </template>
      <p v-if="secretError" class="source-note" :data-testid="id('secret-error')">
        The reference could not be checked ({{ secretError }}). This does not stop you saving — the
        check is an aid, not a gate.
      </p>
    </fieldset>

    <!-- THROUGHPUT & RESILIENCE --------------------------------------------- -->
    <fieldset class="cfg-group">
      <legend>
        <button
          type="button"
          class="cfg-toggle"
          :data-testid="id('toggle-throughput')"
          @click="toggle('throughput')"
        >
          {{ open.throughput ? '▾' : '▸' }} Throughput and resilience
        </button>
      </legend>
      <p class="source-note">
        The rate ceiling is here because the carrier states it. Everything else in this group is an
        override — left blank, the engine's own default applies.
      </p>
      <div class="dialog-grid">
        <label class="field">
          <span>TPS ceiling</span>
          <input
            type="number"
            min="1"
            :value="str('tps')"
            :data-testid="id('tps')"
            @input="setNumber('tps', ($event.target as HTMLInputElement).value)"
          />
          <small
            ><span class="mono">throughput</span> — the rate the carrier has agreed to
            accept.</small
          >
        </label>
        <template v-if="open.throughput">
          <label v-if="isSmpp" class="field">
            <span>Window size</span>
            <input
              type="number"
              min="1"
              :value="str('windowSize')"
              placeholder="10"
              :data-testid="id('windowSize')"
              @input="setNumber('windowSize', ($event.target as HTMLInputElement).value)"
            />
            <small
              ><span class="mono">max-pending-submits</span> — unacknowledged submits in
              flight.</small
            >
          </label>
          <label class="field">
            <span>Parallel connections</span>
            <input
              type="number"
              min="1"
              :value="str('connectionCount')"
              placeholder="1"
              :data-testid="id('connectionCount')"
              @input="setNumber('connectionCount', ($event.target as HTMLInputElement).value)"
            />
            <small>
              <span class="mono">instances</span> — the engine reports these as ONE bind, so
              observed sessions will not match this number.
            </small>
          </label>
          <label v-if="isSmpp" class="field">
            <span>Enquire-link interval (s)</span>
            <input
              type="number"
              min="1"
              :value="str('keepaliveSeconds')"
              placeholder="30"
              :data-testid="id('keepaliveSeconds')"
              @input="setNumber('keepaliveSeconds', ($event.target as HTMLInputElement).value)"
            />
            <small><span class="mono">enquire-link-interval</span> — the keepalive.</small>
          </label>
          <label class="field">
            <span>Reconnect delay (s)</span>
            <input
              type="number"
              min="1"
              :value="str('reconnectDelaySeconds')"
              placeholder="10"
              :data-testid="id('reconnectDelaySeconds')"
              @input="setNumber('reconnectDelaySeconds', ($event.target as HTMLInputElement).value)"
            />
            <small><span class="mono">reconnect-delay</span></small>
          </label>
          <label class="field">
            <span>Connection timeout (s)</span>
            <input
              type="number"
              min="1"
              :value="str('connectionTimeoutSeconds')"
              :data-testid="id('connectionTimeoutSeconds')"
              @input="
                setNumber('connectionTimeoutSeconds', ($event.target as HTMLInputElement).value)
              "
            />
            <small><span class="mono">connection-timeout</span></small>
          </label>
          <label v-if="isSmpp" class="field">
            <span>Wait-ack (s)</span>
            <input
              type="number"
              min="1"
              :value="str('waitAckSeconds')"
              placeholder="60"
              :data-testid="id('waitAckSeconds')"
              @input="setNumber('waitAckSeconds', ($event.target as HTMLInputElement).value)"
            />
            <small
              ><span class="mono">wait-ack</span> — how long to wait for a submit response.</small
            >
          </label>
          <label v-if="isSmpp" class="field">
            <span>On wait-ack expiry</span>
            <select
              :value="str('waitAckExpireAction')"
              :data-testid="id('waitAckExpireAction')"
              @change="setNumber('waitAckExpireAction', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">engine default</option>
              <option value="0">0 — disconnect and reconnect</option>
              <option value="1">1 — re-queue the message</option>
              <option value="2">2 — carry on waiting</option>
            </select>
            <small><span class="mono">wait-ack-expire</span></small>
          </label>
          <label class="field">
            <span>Max consecutive errors</span>
            <input
              type="number"
              min="1"
              :value="str('maxErrorCount')"
              :data-testid="id('maxErrorCount')"
              @input="setNumber('maxErrorCount', ($event.target as HTMLInputElement).value)"
            />
            <small
              ><span class="mono">max-error-count</span> — errors before the bind is dropped.</small
            >
          </label>
          <label v-if="isSmpp" class="field checkbox-row dialog-span">
            <input
              type="checkbox"
              :checked="bool('retryOnAuthFailure')"
              :data-testid="id('retryOnAuthFailure')"
              @change="set('retryOnAuthFailure', ($event.target as HTMLInputElement).checked)"
            />
            <span>
              Keep retrying after an authentication failure (<span class="mono">retry</span>)
            </span>
          </label>
        </template>
      </div>
      <p v-if="open.throughput && isSmpp" class="source-note">
        Raising the window size without the carrier raising theirs produces throttling responses,
        not throughput. The ceiling that binds is whichever is lower.
      </p>
    </fieldset>

    <!-- ADDRESSING ---------------------------------------------------------- -->
    <fieldset v-if="isSmpp" class="cfg-group">
      <legend>
        <button
          type="button"
          class="cfg-toggle"
          :data-testid="id('toggle-addressing')"
          @click="toggle('addressing')"
        >
          {{ open.addressing ? '▾' : '▸' }} Addressing and encoding
        </button>
      </legend>
      <p class="source-note">
        Read straight off the carrier's onboarding sheet. Every one of these is optional; an unset
        field is left out of the configuration entirely, so the engine's default applies.
      </p>
      <div v-if="open.addressing" class="dialog-grid">
        <label class="field">
          <span>Interface version</span>
          <select
            :value="str('interfaceVersion')"
            :data-testid="id('interfaceVersion')"
            @change="setNumber('interfaceVersion', ($event.target as HTMLSelectElement).value)"
          >
            <option value="">engine default (3.4)</option>
            <option value="33">3.3</option>
            <option value="34">3.4</option>
            <option value="50">5.0</option>
          </select>
          <small><span class="mono">interface-version</span></small>
        </label>
        <label class="field">
          <span>Address range</span>
          <input
            :value="str('addressRange')"
            placeholder="^256(77|78)"
            :data-testid="id('addressRange')"
            @input="set('addressRange', ($event.target as HTMLInputElement).value)"
          />
          <small>
            <span class="mono">address-range</span> — a regex the carrier uses to decide which
            inbound traffic to deliver on this bind.
          </small>
        </label>
        <label class="field">
          <span>Alternative charset</span>
          <input
            :value="str('altCharset')"
            placeholder="WINDOWS-1252"
            :data-testid="id('altCharset')"
            @input="set('altCharset', ($event.target as HTMLInputElement).value)"
          />
          <small>
            <span class="mono">alt-charset</span> — set only when the carrier does not use GSM
            03.38.
          </small>
        </label>
        <label class="field">
          <span>Source TON</span>
          <input
            type="number"
            min="0"
            max="6"
            :value="str('sourceAddrTon')"
            :data-testid="id('sourceAddrTon')"
            @input="setNumber('sourceAddrTon', ($event.target as HTMLInputElement).value)"
          />
          <small
            ><span class="mono">source-addr-ton</span> — 1 international, 5 alphanumeric.</small
          >
        </label>
        <label class="field">
          <span>Source NPI</span>
          <input
            type="number"
            min="0"
            max="18"
            :value="str('sourceAddrNpi')"
            :data-testid="id('sourceAddrNpi')"
            @input="setNumber('sourceAddrNpi', ($event.target as HTMLInputElement).value)"
          />
          <small><span class="mono">source-addr-npi</span> — 1 is ISDN/E.164.</small>
        </label>
        <label class="field">
          <span>Destination TON</span>
          <input
            type="number"
            min="0"
            max="6"
            :value="str('destAddrTon')"
            :data-testid="id('destAddrTon')"
            @input="setNumber('destAddrTon', ($event.target as HTMLInputElement).value)"
          />
          <small><span class="mono">dest-addr-ton</span></small>
        </label>
        <label class="field">
          <span>Destination NPI</span>
          <input
            type="number"
            min="0"
            max="18"
            :value="str('destAddrNpi')"
            :data-testid="id('destAddrNpi')"
            @input="setNumber('destAddrNpi', ($event.target as HTMLInputElement).value)"
          />
          <small><span class="mono">dest-addr-npi</span></small>
        </label>
      </div>
    </fieldset>

    <!-- ENGINE-SIDE ROUTING -------------------------------------------------- -->
    <fieldset class="cfg-group">
      <legend>
        <button
          type="button"
          class="cfg-toggle"
          :data-testid="id('toggle-routing')"
          @click="toggle('routing')"
        >
          {{ open.routing ? '▾' : '▸' }} Engine routing rules
        </button>
      </legend>
      <p class="source-note">
        These are the ENGINE's own routing directives, evaluated by bearerbox. They are not the
        console's Carrier Routes, which are evaluated before a message is submitted. Set these only
        when a carrier's own instructions call for them; otherwise leave the whole group empty and
        route on the Routing screen instead.
      </p>
      <div v-if="open.routing" class="dialog-grid">
        <label
          v-for="entry in [
            { key: 'allowedSmscIds', label: 'Allowed smsc-ids', directive: 'allowed-smsc-id' },
            { key: 'deniedSmscIds', label: 'Denied smsc-ids', directive: 'denied-smsc-id' },
            {
              key: 'preferredSmscIds',
              label: 'Preferred smsc-ids',
              directive: 'preferred-smsc-id',
            },
            { key: 'allowedPrefixes', label: 'Allowed prefixes', directive: 'allowed-prefix' },
            { key: 'deniedPrefixes', label: 'Denied prefixes', directive: 'denied-prefix' },
            {
              key: 'preferredPrefixes',
              label: 'Preferred prefixes',
              directive: 'preferred-prefix',
            },
          ]"
          :key="entry.key"
          class="field dialog-span"
        >
          <span>{{ entry.label }}</span>
          <input
            :value="listValue(entry.key)"
            placeholder="256772;256782"
            :data-testid="id(entry.key)"
            @input="setList(entry.key, ($event.target as HTMLInputElement).value)"
          />
          <small>
            <span class="mono">{{ entry.directive }}</span> — semicolon separated, so a value can be
            pasted straight from the carrier's instructions.
          </small>
        </label>
      </div>
    </fieldset>

    <!-- NOTES ---------------------------------------------------------------- -->
    <label class="field dialog-span">
      <span>Notes</span>
      <input
        :value="str('notes')"
        :data-testid="id('notes')"
        @input="set('notes', ($event.target as HTMLInputElement).value)"
      />
      <small>Console only — never rendered into the engine configuration.</small>
    </label>
  </div>
</template>

<style scoped>
.smsc-form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5, 16px);
}
.cfg-group {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px 14px;
  margin: 0;
  min-width: 0;
}
.cfg-group > legend {
  padding: 0 6px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
/* A collapsed group must still read as a heading, so the control is styled as
   the legend rather than as a button sitting inside one. */
.cfg-toggle {
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  color: inherit;
  text-transform: inherit;
  letter-spacing: inherit;
  cursor: pointer;
}
.cfg-toggle:hover {
  color: var(--text-strong);
}
.cfg-group .source-note {
  margin: 0 0 10px;
}
/* "required", set inside the label rather than as a bare asterisk, because an
   asterisk only means required to someone who already knows it does. Toned to
   the kit's warning colour and sized down so it annotates the label instead of
   competing with it. */
.smsc-form .req {
  margin-left: 6px;
  font-style: normal;
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  color: var(--warn);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
/* The hint only turns into a warning while the field is actually empty, so a
   filled-in form is not shouting at an operator who has already done the thing. */
.smsc-form .req-note {
  color: var(--warn);
}
.smsc-form input[aria-invalid='true'] {
  border-color: var(--warn);
}
/* The hint under a field. Sized below the label so the field still reads as one
   thing, and given room so a two-line hint does not crowd the next row. */
.smsc-form :deep(small) {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}
.secret-status {
  margin: 10px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--muted);
}
.secret-status .status-badge {
  margin-right: 6px;
}
</style>
