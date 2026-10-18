// Genie's dashboard conversation. The server owns history; this client only
// renders it and streams one turn at a time.
const $ = id => document.getElementById(id);
let csrf = null;
let busy = false;

function status(text) {
  const node = $('genie-status');
  if (node) node.textContent = text;
}

function note(text) {
  const node = $('genie-note');
  if (node) node.textContent = text;
}

function scroll() {
  const log = $('genie-log');
  if (log) log.scrollTop = log.scrollHeight;
}

function bubble(role, text = '') {
  const log = $('genie-log');
  if (!log) return null;
  const node = document.createElement('div');
  node.className = `genie-message ${role}`;
  const who = document.createElement('span');
  who.className = 'genie-who';
  who.textContent = role === 'user' ? 'You' : role === 'error' ? 'System' : 'Genie';
  const body = document.createElement('p');
  body.textContent = text;
  node.append(who, body);
  log.append(node);
  scroll();
  return body;
}

function render(messages) {
  const log = $('genie-log');
  if (!log) return;
  log.textContent = '';
  if (!messages.length) {
    const empty = document.createElement('p');
    empty.className = 'muted genie-empty';
    empty.textContent = 'No conversation yet. Ask him about the fleet, a worker, or what he would check next.';
    log.append(empty);
    return;
  }
  for (const message of messages) bubble(message.role, message.content);
  scroll();
}

function setBusy(value) {
  busy = value;
  if ($('genie-send')) $('genie-send').disabled = value;
  if ($('genie-stop')) $('genie-stop').disabled = !value;
  if ($('genie-input')) $('genie-input').disabled = value;
}

async function load() {
  try {
    const response = await fetch('/api/genie', {cache: 'no-store'});
    const value = await response.json();
    csrf = value.csrf_token ?? null;
    if (!value.enabled) {
      status('Disabled');
      note(value.error ? value.error : 'Enable Genie in the private configuration to talk to him here.');
      setBusy(false);
    } else if (!value.ready) {
      status('Not ready');
      note(value.error ?? 'His runtime is not ready. Run npm run genie:setup.');
    } else {
      status(`${value.model ?? 'model'} · ${value.tools?.length ? value.tools.length + ' tool' + (value.tools.length === 1 ? '' : 's') : 'no tools'}`);
      note('');
    }
    render(value.messages ?? []);
  } catch {
    status('Unavailable');
    note('The dashboard could not read Genie status.');
  }
}

async function send(event) {
  event.preventDefault();
  if (busy) return;
  const input = $('genie-input');
  const message = input.value.trim();
  if (!message) return;
  const empty = document.querySelector('.genie-empty');
  if (empty) empty.remove();
  input.value = '';
  bubble('user', message);
  const answer = bubble('assistant', '');
  setBusy(true);
  note('Thinking…');
  let received = '';
  try {
    const response = await fetch('/api/genie/chat', {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-dsg-csrf': csrf ?? ''},
      body: JSON.stringify({message}),
    });
    if (!response.ok || !response.body) {
      const failure = await response.json().catch(() => ({error: 'Genie could not answer.'}));
      throw new Error(failure.error ?? 'Genie could not answer.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const line = block.split('\n').find(row => row.startsWith('data: '));
        if (!line) continue;
        let update;
        try { update = JSON.parse(line.slice(6)); } catch { continue; }
        if (typeof update.delta === 'string') {
          received += update.delta;
          answer.textContent = received;
          scroll();
        } else if (typeof update.error === 'string') {
          throw new Error(update.error);
        }
      }
    }
    if (!received) {
      answer.textContent = 'He returned no text. The conversation was kept.';
    }
  } catch (error) {
    if (received) answer.textContent = received;
    else answer.parentElement?.remove();
    bubble('error', error.message);
  } finally {
    setBusy(false);
    note('');
    input.focus();
  }
}

async function stop() {
  try {
    await fetch('/api/genie/chat/stop', {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-dsg-csrf': csrf ?? ''},
      body: '{}',
    });
  } catch { /* the turn will end on its own */ }
}

function wire() {
  const form = $('genie-form');
  if (!form) return;
  form.addEventListener('submit', send);
  $('genie-stop')?.addEventListener('click', stop);
  let loaded = false;
  const observer = new MutationObserver(() => {
    if (loaded || $('view-genie')?.hidden !== false) return;
    loaded = true;
    void load();
  });
  const view = $('view-genie');
  if (view) observer.observe(view, {attributes: true, attributeFilter: ['hidden']});
}

wire();
