import {createHash} from 'node:crypto';

export const PI_CLIENT_SCHEMA = 1;
export const PI_CLIENT_PROVIDER = 'dsg-pool';
// The home-LAN client contract: the served key is the constant 'none'.
// Deliberately NOT config.api_key — a real install ships a random secret and
// serving it here would turn this route into a key-disclosure path.
export const PI_CLIENT_KEY = 'none';
// Pi transport for an OpenAI-compatible endpoint.
export const PI_CLIENT_API = 'openai-completions';
// Relative to base_url, which already ends in /v1.
export const PI_CLIENT_SCRIPT_PATH = '/client/pi/install.ps1';
export const PI_CLIENT_REPORT_PATH = '/client/pi/report';
export const PI_CLIENT_NOTES = 'Home-LAN client profile. Model id is the stable pool label. Key is the home-LAN constant.';
// The thinking levels Pi understands. A served default must be one of these, or
// Pi would be handed a level it cannot map.
export const PI_CLIENT_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const PI_CLIENT_DEFAULT_THINKING = 'high';

const BASE_URL = /^https?:\/\/[^\s/?#]+(?::\d+)?\/v1$/;
const isNonEmptyString = value => typeof value === 'string' && value.length > 0;
const positiveInt = value => Number.isSafeInteger(value) && value > 0;

// Semantic fields only: generated_at and revision are excluded so a re-fetch
// with no real change is byte-identical and reports the same revision.
function semanticFields(bundle) {
  return {
    schema: bundle.schema,
    provider: bundle.provider,
    api: bundle.api,
    base_url: bundle.base_url,
    fallback_base_urls: bundle.fallback_base_urls,
    api_key: bundle.api_key,
    model: bundle.model,
    compat: bundle.compat,
    // Part of the contract, so a change to them must change the revision and
    // prompt a re-sync.
    defaults: bundle.defaults,
    purgeProviders: bundle.purgeProviders,
    script_url: bundle.script_url,
    report_url: bundle.report_url,
    notes: bundle.notes,
  };
}

export function piClientRevision(bundle) {
  return createHash('sha256').update(JSON.stringify(semanticFields(bundle))).digest('hex');
}

// Shallow-merge a validated private override over the committed defaults.
// `model` and `compat` merge one level deeper so an override can change a
// single field without restating the block; every other key replaces whole.
export function mergePiClientTemplate(defaults, override) {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) throw new Error('Client template defaults are required');
  if (override == null) return structuredClone(defaults);
  if (typeof override !== 'object' || Array.isArray(override)) throw new Error('Client template override must be an object');
  const merged = structuredClone(defaults);
  for (const [key, value] of Object.entries(override)) {
    if (key === 'model' || key === 'compat') {
      if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Client template ${key} override must be an object`);
      merged[key] = {...(merged[key] ?? {}), ...structuredClone(value)};
    } else {
      merged[key] = structuredClone(value);
    }
  }
  return merged;
}

export function buildPiClientBundle({baseUrl, fallbackBaseUrls = [], poolModel, contextWindow, template, generatedAt}) {
  if (!isNonEmptyString(baseUrl) || !BASE_URL.test(baseUrl)) throw new Error('A base URL ending in /v1 is required');
  if (!Array.isArray(fallbackBaseUrls) || fallbackBaseUrls.some(url => !isNonEmptyString(url) || !BASE_URL.test(url))) throw new Error('Fallback base URLs must be /v1 URLs');
  if (fallbackBaseUrls.includes(baseUrl)) throw new Error('A fallback base URL must differ from the primary base URL');
  if (!positiveInt(contextWindow)) throw new Error('A positive context window is required');
  if (!isNonEmptyString(generatedAt)) throw new Error('A generated timestamp is required');
  if (!template || typeof template !== 'object' || Array.isArray(template)) throw new Error('A client template is required');

  // R1: the model id is the pool label; only default when config omits it.
  const id = isNonEmptyString(poolModel) ? poolModel : 'PoolModel';
  const source = template.model;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Client template model block is required');
  if (!isNonEmptyString(template.api)) throw new Error('Client template api is required');
  if (!isNonEmptyString(template.provider)) throw new Error('Client template provider is required');
  if (!template.compat || typeof template.compat !== 'object' || Array.isArray(template.compat)) throw new Error('Client template compat block is required');

  // R7: the template budget and the live context are independent sources; never
  // advertise an output budget larger than the context this pool actually has.
  const declared = positiveInt(source.maxTokens) ? source.maxTokens : contextWindow;
  const maxTokens = Math.min(declared, contextWindow);

  // A thinking level Pi cannot map would leave the client unable to start.
  // Explicit-null must be distinguishable from absent: `null` means "serve no
  // default level" (the script then removes the key), so this checks for the
  // key's presence rather than relying on `??`, which cannot see a null.
  const defaultsModel = template.defaults?.model;
  const requestedThinking = defaultsModel && Object.hasOwn(defaultsModel, 'defaultThinkingLevel')
    ? defaultsModel.defaultThinkingLevel
    : Object.hasOwn(source, 'defaultThinkingLevel') ? source.defaultThinkingLevel
    : PI_CLIENT_DEFAULT_THINKING;
  const thinkingLevel = requestedThinking === null || requestedThinking === undefined ? null
    : PI_CLIENT_THINKING_LEVELS.includes(requestedThinking) ? requestedThinking
    : (() => { throw new Error(`Unknown default thinking level: ${requestedThinking}`); })();
  const defaultProvider = isNonEmptyString(template.defaults?.model?.defaultProvider)
    ? template.defaults.model.defaultProvider : template.provider;
  const defaultModel = isNonEmptyString(template.defaults?.model?.defaultModel)
    ? template.defaults.model.defaultModel : id;

  const bundle = {
    schema: PI_CLIENT_SCHEMA,
    generated_at: generatedAt,
    provider: template.provider,
    api: template.api,
    base_url: baseUrl,
    fallback_base_urls: [...fallbackBaseUrls],
    api_key: PI_CLIENT_KEY,
    model: {
      id,
      // R3: the display name comes from the template.
      name: isNonEmptyString(template.display_name) ? template.display_name : id,
      reasoning: source.reasoning === true,
      input: Array.isArray(source.input) ? [...source.input] : ['text'],
      contextWindow,                                   // R2: the live pool context
      maxTokens,
      thinkingLevelMap: structuredClone(source.thinkingLevelMap ?? {}),
      samplingParams: structuredClone(source.samplingParams ?? {}),
      cost: structuredClone(source.cost ?? {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}),
    },
    // R5: client-facing only — no state_file, worker URLs, aliases or ids.
    compat: structuredClone(template.compat),
    // What the client should ADOPT, as opposed to what it should connect to. The
    // script may only apply these when the bundle says so, so a future revision
    // can withhold them without a client-side release. Making the pool the
    // default model and pinning a thinking level is the owner's stated intent for
    // a dedicated client; an operator who wants a cheaper client override sets
    // defaults.model.defaultThinkingLevel to a lower level in config.pi_client.
    defaults: {
      model: {
        defaultProvider,
        defaultModel,
        defaultThinkingLevel: thinkingLevel,
      },
      apply: true,
    },
    // Providers to remove from the client profile so a machine pinned to the pool
    // does not keep dead endpoints. EMPTY by default: deleting a client's other
    // providers is destructive and must be an explicit operator choice, never
    // something a routine sync does on its own.
    //
    // `'all'` means "keep only this provider", which is roster-independent: a
    // hardcoded list of every other provider would rot as the fleet changes, and
    // would silently miss one. Intended for a dedicated client whose operator
    // wants no other models; the script backs the file up first and reports the
    // purge, so it is inspectable and reversible.
    purgeProviders: template.purgeProviders === 'all' ? 'all'
      : Array.isArray(template.purgeProviders) ? [...template.purgeProviders] : [],
    script_url: PI_CLIENT_SCRIPT_PATH,
    report_url: PI_CLIENT_REPORT_PATH,
    notes: PI_CLIENT_NOTES,
  };
  bundle.revision = piClientRevision(bundle);
  return bundle;
}

// Returns the INNER provider object written at providers[provider]:
// {baseUrl, api, apiKey, models:[...], compat}. NOT the {providers:{...}}
// wrapper — the Windows script builds that, and the pair must not drift.
export function piClientProviderObject(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('A client bundle is required');
  const model = bundle.model;
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('A client bundle model is required');
  if (!isNonEmptyString(bundle.base_url)) throw new Error('A client bundle base_url is required');
  if (!isNonEmptyString(bundle.api)) throw new Error('A client bundle api is required');
  if (!isNonEmptyString(bundle.api_key)) throw new Error('A client bundle api_key is required');
  return {
    baseUrl: bundle.base_url,
    api: bundle.api,
    apiKey: bundle.api_key,
    models: [{
      id: model.id,
      name: model.name,
      reasoning: model.reasoning === true,
      input: Array.isArray(model.input) ? [...model.input] : ['text'],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      thinkingLevelMap: structuredClone(model.thinkingLevelMap ?? {}),
      samplingParams: structuredClone(model.samplingParams ?? {}),
      cost: structuredClone(model.cost ?? {}),
    }],
    compat: structuredClone(bundle.compat ?? {}),
  };
}

// PowerShell single-quoted strings escape a quote by doubling it. Nothing else
// is special inside them, so this is the whole defence.
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;

export function renderPiClientScript(template, {baseUrl, fallbackBaseUrls = [], apiKey}) {
  if (!isNonEmptyString(template)) throw new Error('A script template is required');
  if (!isNonEmptyString(baseUrl) || !BASE_URL.test(baseUrl)) throw new Error('A base URL ending in /v1 is required');
  if (!Array.isArray(fallbackBaseUrls) || fallbackBaseUrls.some(url => !isNonEmptyString(url) || !BASE_URL.test(url))) throw new Error('Fallback base URLs must be /v1 URLs');
  if (!isNonEmptyString(apiKey)) throw new Error('An api key value is required');
  const body = template.replace(/^\uFEFF/, '');
  const fallbacks = fallbackBaseUrls.length
    ? fallbackBaseUrls.map(url => `  ${psQuote(url)}`).join('\n')
    : '  # none';
  const preamble = [
    '# Generated defaults (do not edit; re-fetch to update)',
    `$StargateBaseUrl = ${psQuote(baseUrl)}`,
    `$StargateFallbackBaseUrls = @(\n${fallbacks}\n)`,
    `$StargateApiKey  = ${psQuote(apiKey)}`,
    '# --- committed body follows ---',
    '',
  ].join('\n');
  return preamble + body;
}
