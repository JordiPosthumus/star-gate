import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPiClientBundle, piClientProviderObject, piClientRevision,
  mergePiClientTemplate, renderPiClientScript,
  PI_CLIENT_KEY, PI_CLIENT_SCHEMA, PI_CLIENT_PROVIDER, PI_CLIENT_API,
} from './pi-client-config.mjs';
import committedDefaults from './pi-client-defaults.json' with {type: 'json'};

const BASE = 'http://host.invalid:30000/v1';
const template = () => structuredClone(committedDefaults);
const build = over => buildPiClientBundle({
  baseUrl: BASE,
  fallbackBaseUrls: ['http://192.0.2.10:30000/v1'],
  poolModel: 'PoolModel',
  contextWindow: 400000,
  template: template(),
  generatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

test('the committed defaults are generic and secret-free', () => {
  const text = JSON.stringify(committedDefaults);
  assert.equal(committedDefaults.provider, PI_CLIENT_PROVIDER);
  assert.equal(committedDefaults.api, PI_CLIENT_API);
  // AC/C: no private topology or credentials may ever appear in tracked defaults.
  for (const forbidden of ['state_file', 'ssh', 'apiKey', 'api_key', 'sk-', 'Jordi', '.local', '192.168.']) {
    assert.ok(!text.includes(forbidden), `committed defaults must not contain ${forbidden}`);
  }
  const ips = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];
  assert.deepEqual(ips, [], `committed defaults must not contain an IPv4 address, found ${ips}`);
});

test('bundle shape is schema 1 with the pool label and a live context', () => {
  const bundle = build();
  assert.equal(bundle.schema, PI_CLIENT_SCHEMA);
  assert.equal(bundle.provider, PI_CLIENT_PROVIDER);
  assert.equal(bundle.api, PI_CLIENT_API);
  assert.equal(bundle.model.id, 'PoolModel');
  assert.equal(bundle.model.name, '(DSG) Pool');
  assert.equal(bundle.model.contextWindow, 400000);
  assert.equal(bundle.base_url, BASE);
  assert.deepEqual(bundle.fallback_base_urls, ['http://192.0.2.10:30000/v1']);
  assert.equal(bundle.script_url, '/client/pi/install.ps1');
  assert.equal(bundle.report_url, '/client/pi/report');
  assert.match(bundle.revision, /^[a-f0-9]{64}$/);
});

test('api_key is always the constant none, even when the pool has a real key', () => {
  // The gateway holds a random secret in config.api_key. None of it may leak
  // here: this route is reachable by a trusted LAN peer.
  const bundle = build({apiKey: 'a-real-secret-value'});
  assert.equal(bundle.api_key, PI_CLIENT_KEY);
  assert.equal(bundle.api_key, 'none');
  const text = JSON.stringify(bundle);
  assert.ok(!text.includes('a-real-secret-value'));
  assert.equal(piClientProviderObject(bundle).apiKey, 'none');
});

test('no private topology leaks into the bundle', () => {
  const text = JSON.stringify(build());
  for (const forbidden of ['state_file', 'ssh_alias', 'control.sock', 'workers', 'affinity']) {
    assert.ok(!text.includes(forbidden), `bundle must not contain ${forbidden}`);
  }
});

test('detached defaults cannot be mutated through the bundle', () => {
  const source = template();
  const bundle = buildPiClientBundle({baseUrl: BASE, poolModel: 'PoolModel', contextWindow: 400000, template: source, generatedAt: '2026-01-01T00:00:00.000Z'});
  bundle.compat.supportsStore = true;
  bundle.model.cost.input = 99;
  assert.equal(source.compat.supportsStore, false);
  assert.equal(source.model.cost.input, 0);
});

test('the same inputs produce identical bytes and one revision', () => {
  const a = build(), b = build();
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('generated_at alone does not change the revision', () => {
  const a = build({generatedAt: '2026-01-01T00:00:00.000Z'});
  const b = build({generatedAt: '2026-06-06T06:06:06.000Z'});
  assert.equal(a.revision, b.revision);
  assert.notEqual(a.generated_at, b.generated_at);
});

test('a semantic change changes the revision, and the revision excludes itself', () => {
  const base = build();
  assert.notEqual(base.revision, build({poolModel: 'OtherModel'}).revision);
  assert.notEqual(base.revision, build({contextWindow: 262144}).revision);
  assert.notEqual(base.revision, build({baseUrl: 'http://other.invalid:30000/v1'}).revision);
  // A revision computed from the same semantic fields, ignoring the field itself.
  assert.equal(piClientRevision({...base, revision: 'f'.repeat(64)}), base.revision);
});

test('maxTokens is clamped to the live context window', () => {
  const small = build({contextWindow: 8192});
  assert.equal(small.model.maxTokens, 8192);
  assert.equal(small.model.contextWindow, 8192);
  // A larger context keeps the template budget: the pool can serve it.
  const large = build({contextWindow: 400000});
  assert.equal(large.model.maxTokens, 262144);
  assert.ok(large.model.maxTokens <= large.model.contextWindow);
});

test('the model id follows config and defaults only when config omits it', () => {
  assert.equal(build({poolModel: 'GLM-5.3-Flash'}).model.id, 'GLM-5.3-Flash');
  assert.equal(build({poolModel: undefined}).model.id, 'PoolModel');
  assert.equal(build({poolModel: ''}).model.id, 'PoolModel');
});

test('a malformed base URL or fallback is rejected rather than served', () => {
  for (const bad of ['http://host.invalid:30000', 'host.invalid/v1', 'ftp://host.invalid/v1', 'http://host.invalid/v1/extra', '']) {
    assert.throws(() => build({baseUrl: bad}), /base URL/i, `should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => build({fallbackBaseUrls: ['nope']}), /Fallback/i);
  // A fallback equal to the primary would make the script retry the same dead URL.
  assert.throws(() => build({fallbackBaseUrls: [BASE]}), /differ/i);
});

test('the merged template can override one field without restating a block', () => {
  const merged = mergePiClientTemplate(template(), {display_name: '(DSG) Private', compat: {supportsStore: true}});
  assert.equal(merged.display_name, '(DSG) Private');
  assert.equal(merged.compat.supportsStore, true);
  // Untouched fields survive the merge.
  assert.equal(merged.compat.supportsReasoningEffort, true);
  assert.equal(merged.model.maxTokens, 262144);
  assert.equal(merged.provider, PI_CLIENT_PROVIDER);
  // And the committed defaults are untouched by the merge.
  assert.equal(template().compat.supportsStore, false);
});

test('a null override is the committed defaults, and a bad override is rejected', () => {
  assert.deepEqual(mergePiClientTemplate(template(), null), template());
  assert.throws(() => mergePiClientTemplate(template(), []), /override/i);
  assert.throws(() => mergePiClientTemplate(null, {}), /defaults/i);
  assert.throws(() => mergePiClientTemplate(template(), {model: 'nope'}), /model override/i);
});

test('piClientProviderObject returns the inner provider, not the wrapper', () => {
  const provider = piClientProviderObject(build());
  assert.deepEqual(Object.keys(provider).sort(), ['api', 'apiKey', 'baseUrl', 'compat', 'models']);
  assert.equal(provider.baseUrl, BASE);
  assert.equal(provider.api, PI_CLIENT_API);
  assert.equal(provider.apiKey, 'none');
  assert.equal(Array.isArray(provider.models), true);
  assert.equal(provider.models.length, 1);
  assert.equal(provider.models[0].id, 'PoolModel');
  // compat sits at the provider level next to models — Pi reads it there.
  assert.equal(provider.compat.maxTokensField, 'max_tokens');
  assert.equal(provider.compat.thinkingFormat, 'chat-template');
  // The nested object must survive as an object; the Windows script writes
  // this file and a -Depth mistake there would stringify it.
  assert.equal(typeof provider.compat.chatTemplateKwargs, 'object');
  assert.equal(provider.compat.chatTemplateKwargs.enable_thinking.$var, 'thinking.enabled');
  assert.equal(provider.compat.chatTemplateKwargs.reasoning_effort.omitWhenOff, true);
  assert.equal('providers' in provider, false);
});

test('the provider object carries every field Pi needs to load a model', () => {
  const model = piClientProviderObject(build()).models[0];
  for (const field of ['id', 'name', 'reasoning', 'input', 'contextWindow', 'maxTokens', 'thinkingLevelMap', 'samplingParams', 'cost']) {
    assert.ok(field in model, `model must carry ${field}`);
  }
  assert.equal(model.thinkingLevelMap.xhigh, 'max');
  assert.equal(model.thinkingLevelMap.max, 'max');
  assert.equal(model.thinkingLevelMap.medium, null);
  assert.equal(model.contextWindow, 400000);
  assert.equal(model.maxTokens, 262144);
});

test('the script preamble carries the live values and a fallback array', () => {
  const script = renderPiClientScript('# committed body\nWrite-Host "hi"\n', {baseUrl: BASE, fallbackBaseUrls: ['http://192.0.2.10:30000/v1', 'http://192.0.2.11:30000/v1'], apiKey: 'none'});
  assert.match(script, /# Generated defaults \(do not edit; re-fetch to update\)/);
  assert.match(script, /\$StargateBaseUrl = 'http:\/\/host\.invalid:30000\/v1'/);
  assert.match(script, /\$StargateApiKey {2}= 'none'/);
  assert.match(script, /'http:\/\/192\.0\.2\.10:30000\/v1'/);
  assert.match(script, /'http:\/\/192\.0\.2\.11:30000\/v1'/);
  assert.match(script, /# --- committed body follows ---/);
  assert.ok(script.endsWith('# committed body\nWrite-Host "hi"\n'), 'the committed body must follow the preamble verbatim');
  assert.ok(script.indexOf('# --- committed body follows ---') < script.indexOf('# committed body'));
});

test('the script preamble renders an empty fallback array without inventing a URL', () => {
  const script = renderPiClientScript('body\n', {baseUrl: BASE, fallbackBaseUrls: [], apiKey: 'none'});
  assert.match(script, /\$StargateFallbackBaseUrls = @\(\n {2}# none\n\)/);
});

test('the preamble escapes a quote so it cannot break out of the string', () => {
  const script = renderPiClientScript('body\n', {baseUrl: BASE, fallbackBaseUrls: ["http://o'brien.invalid:30000/v1"], apiKey: 'none'});
  assert.match(script, /'http:\/\/o''brien\.invalid:30000\/v1'/);
  const quoted = renderPiClientScript('body\n', {baseUrl: BASE, apiKey: "no'ne"});
  assert.match(quoted, /\$StargateApiKey {2}= 'no''ne'/);
});

test('script rendering refuses a malformed base URL or a missing key', () => {
  assert.throws(() => renderPiClientScript('body', {baseUrl: 'http://host.invalid:30000', apiKey: 'none'}), /base URL/i);
  assert.throws(() => renderPiClientScript('body', {baseUrl: BASE, apiKey: ''}), /api key/i);
  assert.throws(() => renderPiClientScript('', {baseUrl: BASE, apiKey: 'none'}), /template/i);
});

test('an invalid context window is refused rather than silently defaulted', () => {
  for (const bad of [0, -1, 1.5, 'many', null, undefined]) {
    assert.throws(() => build({contextWindow: bad}), /context window/i, `should reject ${String(bad)}`);
  }
});

test('a missing or malformed template block is refused', () => {
  assert.throws(() => build({template: {...template(), api: ''}}), /api/i);
  assert.throws(() => build({template: {...template(), provider: undefined}}), /provider/i);
  assert.throws(() => build({template: {...template(), compat: null}}), /compat/i);
  assert.throws(() => build({template: {...template(), model: null}}), /model/i);
});

// --- served client defaults: default model + thinking level -----------------
// The pool must be what the client starts on. Until now the bundle only said how
// to CONNECT; the default model and thinking level live in the client's
// settings.json, so without these the client would join the pool but keep
// starting on whatever model it had before.

test('the bundle makes the pool the default model and carries a thinking level', () => {
  const bundle = build();
  assert.equal(bundle.defaults.apply, true);
  assert.equal(bundle.defaults.model.defaultProvider, PI_CLIENT_PROVIDER);
  assert.equal(bundle.defaults.model.defaultModel, 'PoolModel');
  assert.equal(bundle.defaults.model.defaultThinkingLevel, 'high');
});

test('an operator can pin a different thinking level without a code change', () => {
  const bundle = build({template: mergePiClientTemplate(template(), {defaults: {model: {defaultThinkingLevel: 'low'}}})});
  assert.equal(bundle.defaults.model.defaultThinkingLevel, 'low');
});

test('a thinking level Pi cannot map is refused rather than served', () => {
  // Serving an unknown level would leave the client unable to resolve a
  // thinking setting at startup.
  assert.throws(() => build({template: mergePiClientTemplate(template(), {defaults: {model: {defaultThinkingLevel: 'turbo'}}})}),
    /Unknown default thinking level/);
});

test('a null thinking level is honoured as "no default", not as a missing value', () => {
  const bundle = build({template: mergePiClientTemplate(template(), {defaults: {model: {defaultThinkingLevel: null}}})});
  assert.equal(bundle.defaults.model.defaultThinkingLevel, null);
});

test('changing the served defaults changes the revision so clients re-sync', () => {
  const before = build();
  const after = build({template: mergePiClientTemplate(template(), {defaults: {model: {defaultThinkingLevel: 'max'}}})});
  assert.notEqual(before.revision, after.revision);
  assert.notEqual(piClientRevision(before), piClientRevision(after));
});

test('purge defaults to nothing, so a routine sync is never destructive', () => {
  const bundle = build();
  assert.deepEqual(bundle.purgeProviders, []);
});

test("purge 'all' keeps only the synced provider, without naming the others", () => {
  // Roster-independent: a hardcoded list of every other provider would rot as
  // the fleet changes, and would silently miss one.
  const bundle = build({template: mergePiClientTemplate(template(), {purgeProviders: 'all'})});
  assert.equal(bundle.purgeProviders, 'all');
});

test('an explicit purge list is carried through as given', () => {
  const bundle = build({template: mergePiClientTemplate(template(), {purgeProviders: ['m3-lane', 'old-spark']})});
  assert.deepEqual(bundle.purgeProviders, ['m3-lane', 'old-spark']);
});

test('a purge list is copied, so a caller cannot mutate the served bundle', () => {
  const source = ['a-lane'];
  const bundle = build({template: mergePiClientTemplate(template(), {purgeProviders: source})});
  source.push('b-lane');
  assert.deepEqual(bundle.purgeProviders, ['a-lane']);
});

test('purge changes the revision', () => {
  const before = build();
  const after = build({template: mergePiClientTemplate(template(), {purgeProviders: 'all'})});
  assert.notEqual(before.revision, after.revision);
});
