import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { App } from '../src/app';
import { AGENCY_DEVELOPER_INSTRUCTIONS } from '../src/agency-environment';
import { WorkspaceFiles } from '../src/workspace-files';
import type { ServerMessage } from '../src/contracts';
import { FakeEngine } from './fake-engine';
import {
  DEFAULT_ROUTES,
  PROFILE_FILE,
  WELCOME_USES,
  parseProfile,
  suggestedRoutes,
  welcomeAnswers,
} from '../src/welcome';
import { readWelcomeProfile, saveWelcomeProfile } from '../src/welcome-profile';

async function fixture() {
  await mkdir('.local', { recursive: true });
  const temp = await mkdtemp(resolve('.local/welcome-'));
  const root = join(temp, 'agencia'), data = join(temp, 'datos');
  const app = new App(new FakeEngine(), data, () => {}, undefined, new WorkspaceFiles(root));
  await app.start();
  return {
    temp,
    root,
    data,
    app,
    reply: (messages: ServerMessage[]) => (message: ServerMessage) => { messages.push(message); },
    reopen: () => {
      const reopened = new App(new FakeEngine(), data, () => {}, undefined, new WorkspaceFiles(root));
      return reopened;
    },
    close: () => rm(temp, { recursive: true, force: true }),
  };
}

test('the welcome shows once, saves the answers to perfil.md and picks the routes', async () => {
  const f = await fixture();
  try {
    assert.equal(f.app.snapshot().welcome, 'pending');
    assert.deepEqual(f.app.snapshot().uses, []);

    const messages: ServerMessage[] = [];
    await f.app.command(
      {
        type: 'welcome',
        answers: {
          agency: '  787   Rumbos ',
          person: 'Fernanda',
          uses: ['imagenes', 'presupuestos'],
          other: 'Videos para historias',
        },
      },
      f.reply(messages),
    );

    assert.equal(f.app.snapshot().welcome, 'done');
    assert.deepEqual(f.app.snapshot().uses, ['imagenes', 'presupuestos']);
    assert.equal(messages.some((message) => message.type === 'problem'), false);

    const profile = await readFile(join(f.root, PROFILE_FILE), 'utf8');
    assert.match(profile, /^# Perfil de la agencia$/m);
    assert.match(profile, /^- \*\*Agencia:\*\* 787 Rumbos$/m);
    assert.match(profile, /^- \*\*Nombre:\*\* Fernanda$/m);
    assert.match(profile, /^- \*\*Usos:\*\* Imágenes para vender, Presupuestos y cotizaciones$/m);
    assert.match(profile, /^- \*\*Otra:\*\* Videos para historias$/m);

    // What was marked goes first; the third is the one of always.
    assert.deepEqual(suggestedRoutes(f.app.snapshot().uses), [
      'Armame placas para historias con este link',
      'Armame una cotización con este link',
      'Armame una propuesta con este link',
    ]);

    const settings = JSON.parse(await readFile(join(f.data, 'settings.json'), 'utf8'));
    assert.equal(settings.welcome, 'done');

    // It is not shown again, and the uses come from the file, not from settings.
    const again = f.reopen();
    await again.start();
    assert.equal(again.snapshot().welcome, 'done');
    assert.deepEqual(again.snapshot().uses, ['imagenes', 'presupuestos']);
    await again.close();
  } finally { await f.close(); }
});

test('skipping the welcome is remembered and does not write a profile', async () => {
  const f = await fixture();
  try {
    const messages: ServerMessage[] = [];
    await f.app.command({ type: 'skipWelcome' }, f.reply(messages));
    assert.equal(f.app.snapshot().welcome, 'skipped');
    assert.equal(messages.some((message) => message.type === 'problem'), false);
    assert.equal(existsSync(join(f.root, PROFILE_FILE)), false);
    assert.deepEqual(f.app.snapshot().uses, []);
    assert.deepEqual(suggestedRoutes(f.app.snapshot().uses), [...DEFAULT_ROUTES]);

    const again = f.reopen();
    await again.start();
    assert.equal(again.snapshot().welcome, 'skipped');
    await again.close();
  } finally { await f.close(); }
});

test('a refused answer keeps the welcome on screen, and a second answer is ignored', async () => {
  const f = await fixture();
  try {
    const messages: ServerMessage[] = [];
    await f.app.command(
      { type: 'welcome', answers: { agency: '  ', person: 'Fernanda', uses: [] } },
      f.reply(messages),
    );
    assert.equal(f.app.snapshot().welcome, 'pending');
    assert.equal(existsSync(join(f.root, PROFILE_FILE)), false);
    const problem = messages.find((message) => message.type === 'problem');
    assert.ok(problem && problem.type === 'problem' && /nombre de tu agencia/.test(problem.text));

    await f.app.command(
      { type: 'welcome', answers: { agency: 'A'.repeat(81), person: 'Fernanda', uses: [] } },
      f.reply(messages),
    );
    assert.equal(f.app.snapshot().welcome, 'pending');

    // A use that is not offered is dropped instead of failing the save.
    await f.app.command(
      { type: 'welcome', answers: { agency: '787 Rumbos', person: 'Fernanda', uses: ['inventado'] } },
      f.reply(messages),
    );
    assert.equal(f.app.snapshot().welcome, 'done');
    assert.deepEqual(f.app.snapshot().uses, []);

    // Another window answering later does not rewrite what was saved.
    const saved = await readFile(join(f.root, PROFILE_FILE), 'utf8');
    await f.app.command(
      { type: 'welcome', answers: { agency: 'Otra agencia', person: 'Otra persona', uses: ['orden'] } },
      f.reply(messages),
    );
    assert.equal(await readFile(join(f.root, PROFILE_FILE), 'utf8'), saved);
  } finally { await f.close(); }
});

test('a lost settings.json does not ask again when perfil.md is there', async () => {
  const f = await fixture();
  try {
    await f.app.command(
      { type: 'welcome', answers: { agency: '787 Rumbos', person: 'Fernanda', uses: ['consultas'] } },
      () => {},
    );
    await rm(join(f.data, 'settings.json'));
    const again = f.reopen();
    await again.start();
    assert.equal(again.snapshot().welcome, 'done');
    assert.deepEqual(again.snapshot().uses, ['consultas']);
    await again.close();
  } finally { await f.close(); }
});

test('the profile is written even when the agency folder does not exist yet', async () => {
  const f = await fixture();
  try {
    const missing = join(f.temp, 'todavia', 'sin-carpeta');
    await saveWelcomeProfile(missing, { agency: 'Agencia Nueva', person: 'Ana', uses: ['orden'] });
    const profile = await readFile(join(missing, PROFILE_FILE), 'utf8');
    assert.match(profile, /^- \*\*Agencia:\*\* Agencia Nueva$/m);
    assert.deepEqual((await readWelcomeProfile(missing)).uses, ['orden']);
    // A folder without a profile (or without the folder) reads as nothing marked.
    assert.deepEqual((await readWelcomeProfile(join(f.temp, 'vacia'))).uses, []);
    assert.deepEqual((await readWelcomeProfile(missing)).agency, 'Agencia Nueva');
  } finally { await f.close(); }
});

test('a profile edited by the agent or by hand never breaks the suggestions', async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.root, PROFILE_FILE),
      '# Perfil de la agencia\n\n- **Agencia:** 787 Rumbos\n- **Nombre:** Fer\n- **Usos:** responder consultas, inventado\n- Un renglón cualquiera\n',
      'utf8',
    );
    const profile = await readWelcomeProfile(f.root);
    assert.deepEqual(profile.uses, ['consultas']);
    assert.equal(profile.person, 'Fer');

    assert.deepEqual(parseProfile('# Perfil\n\n- **Usos:** orden, imagenes\n').uses, ['orden', 'imagenes']);
    assert.deepEqual(parseProfile('# Nada que ver\n').uses, []);
    assert.equal(welcomeAnswers({ agency: ' A ', person: ' B ', uses: ['orden', 'orden'] }).uses.length, 1);
  } finally { await f.close(); }
});

test('the empty screen always shows three different routes, the ones of today without uses', () => {
  assert.deepEqual(suggestedRoutes(undefined), [...DEFAULT_ROUTES]);
  assert.deepEqual(suggestedRoutes([]), [...DEFAULT_ROUTES]);
  assert.deepEqual(suggestedRoutes(['desconocido']), [...DEFAULT_ROUTES]);
  for (const uses of [[], ['imagenes'], ['consultas'], WELCOME_USES.map((use) => use.id)]) {
    const routes = suggestedRoutes(uses);
    assert.equal(routes.length, 3, String(uses));
    assert.equal(new Set(routes).size, 3, String(uses));
  }
});

test('the agent and the interview read perfil.md instead of asking again', async () => {
  assert.match(AGENCY_DEVELOPER_INSTRUCTIONS, /perfil\.md/);
  assert.match(AGENCY_DEVELOPER_INSTRUCTIONS, /no vuelvas a preguntar lo que ya\s+está/i);
  const agents = await readFile(join('kit', 'turismo', 'AGENTS.md'), 'utf8');
  assert.match(agents, /perfil\.md/);
  assert.match(agents, /no vuelvas a preguntar lo que ya\s+está/i);
  const skill = await readFile(join('kit', 'turismo', '.agents', 'skills', 'entrevista', 'SKILL.md'), 'utf8');
  assert.match(skill, /perfil\.md/);
  assert.match(skill, /preguntá solo la firma|cómo le gusta firmar/i);
});
