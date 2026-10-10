"""Small SGUI adapter to native Hermes configuration; never an agent loop."""
import copy, hashlib, json, os, re, sys, uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlsplit

from hermes_cli.config import require_readable_config_before_write, atomic_config_write

home = Path(os.environ["HERMES_HOME"])
file = home / "config.yaml"

def _normalize_provider_name(value):
    return str(value or "").strip().lower().replace(" ", "-")

def _custom_provider_entries(config):
    entries = config.get("custom_providers")
    return entries if isinstance(entries, list) else []

def _has_authorization_header(headers):
    return isinstance(headers, dict) and any(str(name).strip().lower() == "authorization" for name in headers)

def _stored_key_set(config, provider, base_url):
    """Whether a credential is stored for this provider/route. Never returns the secret."""
    wanted = _normalize_provider_name(provider)
    for entry in _custom_provider_entries(config):
        if not isinstance(entry, dict): continue
        if _normalize_provider_name(entry.get("name")) != wanted: continue
        if entry.get("api_key") or entry.get("key_env") or entry.get("key_cmd"): return True
        if _has_authorization_header(entry.get("extra_headers")): return True
    if base_url:
        try:
            from hermes_cli.config import get_custom_provider_extra_headers
            if _has_authorization_header(get_custom_provider_extra_headers(base_url, _custom_provider_entries(config))): return True
        except Exception:
            pass
    return False

def _store_provider_key(config, provider, base_url, key):
    """Persist a typed key for one endpoint. Blank is never passed here (blank keeps the stored key)."""
    entries = config.get("custom_providers")
    if entries is None:
        entries = []; config["custom_providers"] = entries
    if not isinstance(entries, list):
        raise ValueError("custom_providers in config.yaml must be a list; run 'hermes doctor' to repair it.")
    wanted = _normalize_provider_name(provider)
    entry = next((item for item in entries if isinstance(item, dict) and _normalize_provider_name(item.get("name")) == wanted), None)
    if entry is None:
        entry = {"name": provider}; entries.append(entry)
    entry["base_url"] = base_url
    entry["api_key"] = key
    headers = entry.get("extra_headers")
    if isinstance(headers, dict):
        for name in [name for name in headers if str(name).strip().lower() == "authorization"]: headers.pop(name, None)
        if not headers: entry.pop("extra_headers", None)
    # Hermes rewrites placeholder/short secrets ("none", "123") to "no-key-required" on loopback
    # endpoints. A literal Authorization header wins over the SDK-generated one, so pin it for
    # exactly those values (this oMLX lane's key is literally the word "none").
    from hermes_cli.auth import has_usable_secret
    if not has_usable_secret(key):
        headers = entry.get("extra_headers")
        if not isinstance(headers, dict): headers = {}
        headers["Authorization"] = "Bearer " + key
        entry["extra_headers"] = headers

def raw():
    if not file.exists():
        raise ValueError("Set up native Hermes first; its config.yaml is missing.")
    return require_readable_config_before_write(file)

def snapshot():
    cfg = raw()
    model = cfg.get("model") or {}
    if isinstance(model, str): model = {"default": model}
    effort = (cfg.get("agent") or {}).get("reasoning_effort", "")
    compression = cfg.get("compression") or {}
    # Read the installed native default, without materialising it in config.yaml.
    from hermes_cli.config import DEFAULT_CONFIG
    cap = compression.get("threshold_tokens", DEFAULT_CONFIG.get("compression", {}).get("threshold_tokens"))
    return {"settings": {"provider": model.get("provider", ""), "model": model.get("default", ""),
        "base_url": model.get("base_url", ""), "reasoning": "none" if effort is False else effort,
        "compaction_tokens": "" if cap is None else str(cap),
        "api_key": "", "api_key_set": _stored_key_set(cfg, model.get("provider", ""), model.get("base_url", ""))},
        "revision": hashlib.sha256(file.read_bytes()).hexdigest(), "path": str(file)}

def validate(settings):
    if not isinstance(settings, dict): raise ValueError("Brain settings are required.")
    for key in ("provider", "model", "base_url", "reasoning"):
        if not isinstance(settings.get(key), str): raise ValueError("Each brain field must be text.")
    if not settings["provider"].strip() or not settings["model"].strip():
        raise ValueError("Choose a provider and model.")
    if "api_key" in settings:
        key = settings["api_key"]
        if not isinstance(key, str): raise ValueError("API key must be text.")
        if len(key) > 4096: raise ValueError("API key is too long.")
        if any(ord(character) < 32 or ord(character) == 127 for character in key): raise ValueError("API key must not contain control characters.")
    if "compaction_tokens" in settings:
        cap = settings["compaction_tokens"]
        if not isinstance(cap, str) or (cap.strip() and (
            not re.fullmatch(r"[0-9]{1,16}", cap.strip()) or not 1 <= int(cap.strip()) <= 9007199254740991)):
            raise ValueError("Compaction point must be a positive whole number of tokens (up to 9,007,199,254,740,991), or blank to use Hermes' percentage threshold.")
    if settings["base_url"]:
        url = urlsplit(settings["base_url"])
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
            raise ValueError("Use an HTTP(S) endpoint without embedded credentials.")

def save(data):
    settings=data.get("settings"); validate(settings)
    before=snapshot()
    if data.get("revision") != before["revision"]:
        return {"error":"Brain settings changed on disk. Your draft is retained; reload to compare.", "status":409}
    cfg=raw(); updated=copy.deepcopy(cfg)
    if isinstance(updated.get("model"), str): updated["model"]={"default":updated["model"]}
    model=updated.setdefault("model", {})
    model["provider"]=settings["provider"].strip(); model["default"]=settings["model"].strip()
    if settings["base_url"].strip(): model["base_url"]=settings["base_url"].strip()
    else: model.pop("base_url",None)
    agent=updated.setdefault("agent",{})
    if settings["reasoning"]: agent["reasoning_effort"]=settings["reasoning"]
    else: agent.pop("reasoning_effort",None)
    # Older dashboard tabs omit this field. An unchanged native default also
    # stays implicit, so unrelated saves cannot pin or remove a compaction cap.
    if "compaction_tokens" in settings and settings["compaction_tokens"].strip() != before["settings"]["compaction_tokens"]:
        cap = settings["compaction_tokens"].strip()
        compression = updated.get("compression")
        if compression is None: compression = {}; updated["compression"] = compression
        compression["threshold_tokens"] = int(cap) if cap else None
    key = (settings.get("api_key") or "").strip()
    if key:
        if not settings["base_url"].strip(): raise ValueError("An API endpoint is required to store an API key.")
        _store_provider_key(updated, settings["provider"].strip(), settings["base_url"].strip(), key)
    if updated == cfg: return snapshot()
    backups=home/"brain-history";backups.mkdir(mode=0o700,exist_ok=True)
    backup=backups/(datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")+"-"+uuid.uuid4().hex+".yaml")
    backup.write_bytes(file.read_bytes());backup.chmod(0o600)
    # Native writer preserves comments and unrelated settings and replaces atomically.
    if hashlib.sha256(file.read_bytes()).hexdigest()!=before["revision"]:
        return {"error":"Brain settings changed during save. Reload to compare.","status":409}
    atomic_config_write(file,updated)
    result=snapshot();result["backup"]=str(backup);return result

def test_connection(data):
    settings=data.get("settings");validate(settings)
    from hermes_cli.config import load_env
    for env_name,value in load_env().items(): os.environ.setdefault(env_name,value)
    draft_key=(settings.get("api_key") or "").strip()
    base_url=(settings.get("base_url") or "").strip()
    runtime=None
    # A typed key is a draft probe: use it verbatim against the typed endpoint instead of
    # resolving stored credentials (which may not exist yet, or may rewrite placeholder keys).
    if not (base_url and draft_key):
        from hermes_cli.runtime_provider import resolve_runtime_provider
        runtime=resolve_runtime_provider(requested=settings["provider"],explicit_base_url=settings["base_url"] or None,target_model=settings["model"])
    base=base_url or (runtime or {}).get("base_url")
    if not base or not str(base).startswith(("http://","https://")):
        return {"ok":False,"message":"Native provider resolved, but this transport has no HTTP model-list check. No inference was submitted."}
    headers={"Accept":"application/json"};key=draft_key or (runtime or {}).get("api_key")
    if key: headers["Authorization"]="Bearer "+key
    if (runtime or {}).get("api_mode")=="anthropic_messages":
        headers.pop("Authorization",None);headers.update({"x-api-key":key or "","anthropic-version":"2023-06-01"})
    request=Request(str(base).rstrip("/")+"/models",headers=headers)
    with urlopen(request,timeout=10) as response: value=json.loads(response.read(2*1024*1024))
    models=[m["id"] for m in value.get("data",[]) if isinstance(m,dict) and isinstance(m.get("id"),str)]
    found=settings["model"] in models
    return {"ok":True,"model_listed":found,"models":models,"message":"Connected. "+("Selected model is listed." if found else "Selected model was not listed; some providers accept unlisted aliases.")+" No inference was submitted."}

try:
    data=json.load(sys.stdin)
    result=save(data) if data.get("action")=="save" else test_connection(data) if data.get("action")=="test" else snapshot()
except Exception as error:
    # Avoid returning credential-bearing URLs or provider exceptions to the browser.
    result={"error":str(error) if isinstance(error,ValueError) else "Native Hermes could not complete this request ("+type(error).__name__+"). Check the profile or provider connection.","status":400}
print(json.dumps(result))
