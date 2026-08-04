<script setup lang="ts">
import { computed } from 'vue';
import AppIcon from '../components/AppIcon.vue';
import { documentationUrl, navigation, userGuides } from '../navigation';
import { canAccess, session } from '../stores/session';

/**
 * The guides are Markdown files in the repository, which this SPA cannot serve,
 * so every guide link goes to the GitHub-hosted copy in a new tab. What the page
 * itself contributes is findability: the first-run sequence in order, each step
 * deep-linked both to the console screen it is about and to the guide that
 * explains it, so a lost operator gets an answer without leaving the console.
 */

interface FirstRunStep {
  title: string;
  detail: string;
  /** Index into userGuides by published guide number. */
  guide: number;
  route?: string;
}

const firstRunSteps: FirstRunStep[] = [
  {
    title: 'Take the console tour',
    detail:
      'Learn the navigation groups, the search palette (Ctrl K), and the conventions every screen shares.',
    guide: 1,
    route: '/dashboard/operations',
  },
  {
    title: 'Connect an SMSC',
    detail:
      'Add the gateway connection, generate and deploy its configuration, and get the carrier bind up.',
    guide: 2,
    route: '/smsc',
  },
  {
    title: 'Route traffic',
    detail: 'Decide which connection each message takes, then prove it with the resolve preview.',
    guide: 5,
    route: '/routing',
  },
  {
    title: 'Send a message',
    detail: 'Send one message or a bulk campaign, and watch it move through the live queue.',
    guide: 3,
    route: '/bulk-send',
  },
  {
    title: 'Watch and recover',
    detail:
      'Watch per-bind queue depth, stop a bad bind, and resend the failed traffic somewhere else.',
    guide: 4,
    route: '/live-queue',
  },
  {
    title: 'Get alerted, then get numbers out',
    detail:
      'Set the conditions that page a human, then build the reports and exports that answer for them.',
    guide: 6,
    route: '/alerts',
  },
];

const guideByNumber = computed(() => new Map(userGuides.map((guide) => [guide.number, guide])));

/** Only offer a console deep-link the signed-in operator may actually open. */
function reachable(path?: string) {
  if (!path) return false;
  const item = navigation.find((entry) => entry.to === path);
  return Boolean(item) && canAccess(session.value, item?.permission);
}
function guideFor(number: number) {
  return guideByNumber.value.get(number);
}
</script>

<template>
  <div class="help-page" data-testid="help-view">
    <section class="panel" aria-label="Documentation">
      <header class="panel-header">
        <div>
          <h2>Operator guides</h2>
          <p>
            Task-oriented manuals for running JKANNEL. Each guide covers one job, with numbered
            steps that name the actual screens, buttons and fields in this console.
          </p>
        </div>
        <a
          class="primary-button"
          data-testid="help-open-guides"
          :href="documentationUrl"
          target="_blank"
          rel="noopener noreferrer"
        >
          Open the guides<AppIcon name="external" :size="15" />
        </a>
      </header>
      <p class="source-note">
        The guides are Markdown in the JKANNEL repository, so they open on GitHub in a new tab. They
        describe what the console does today — including the parts that do not work yet.
      </p>
    </section>

    <section class="panel" aria-label="Getting started">
      <header class="panel-header">
        <div>
          <h2>Getting started</h2>
          <p>The first-run sequence, in order. Each step links to the screen and to its guide.</p>
        </div>
      </header>
      <ol class="help-steps" data-testid="help-steps">
        <li v-for="(step, index) in firstRunSteps" :key="step.title">
          <span class="help-step-number" aria-hidden="true">{{ index + 1 }}</span>
          <div>
            <strong>{{ step.title }}</strong>
            <small>{{ step.detail }}</small>
            <span class="help-step-links">
              <RouterLink v-if="reachable(step.route)" class="text-link" :to="step.route!"
                >Open the screen</RouterLink
              >
              <a
                v-if="guideFor(step.guide)"
                class="text-link"
                :href="guideFor(step.guide)!.url"
                target="_blank"
                rel="noopener noreferrer"
                >Guide {{ step.guide }}: {{ guideFor(step.guide)!.title }}</a
              >
            </span>
          </div>
        </li>
      </ol>
    </section>

    <section class="panel" aria-label="All guides">
      <header class="panel-header">
        <div>
          <h2>All guides</h2>
          <p>{{ userGuides.length }} guides</p>
        </div>
      </header>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Guide</th>
              <th scope="col">Read it when you want to</th>
              <th scope="col">Screen</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="guide in userGuides"
              :key="guide.number"
              :data-testid="`guide-${guide.number}`"
            >
              <td>{{ guide.number }}</td>
              <td>
                <a class="text-link" :href="guide.url" target="_blank" rel="noopener noreferrer"
                  >{{ guide.title }}<AppIcon name="external" :size="13"
                /></a>
              </td>
              <td>{{ guide.purpose }}</td>
              <td>
                <RouterLink v-if="reachable(guide.route)" class="text-link" :to="guide.route!"
                  >Open</RouterLink
                >
                <span v-else>—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style src="./workspace-extras.css"></style>

<style scoped>
.help-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
}
.help-steps {
  display: grid;
  gap: 14px;
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: none;
}
.help-steps li {
  display: grid;
  grid-template-columns: 28px 1fr;
  gap: 12px;
  align-items: start;
}
.help-step-number {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--brand) 15%, transparent);
  color: var(--brand);
  font-size: 12px;
  font-weight: 700;
}
.help-steps strong {
  display: block;
  color: var(--text-strong);
}
.help-steps small {
  display: block;
  color: var(--muted);
  margin: 2px 0 4px;
}
.help-step-links {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 13px;
}
.help-page a svg {
  vertical-align: -2px;
  margin-left: 5px;
}
</style>
