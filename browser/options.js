const $ = (id) => document.getElementById(id);

chrome.storage.local.get(['port', 'token', 'debug']).then((s) => {
    $('port').value = s.port || '';
    $('token').value = s.token || '';
    $('debug').checked = !!s.debug;
});

// "27121:3f9c..." from "Codeforces: Relay info" — split into the two real
// fields and clear itself so it doesn't look like a third persisted value.
$('pasteAll').addEventListener('input', () => {
    const m = /^\s*(\d+)\s*:\s*([0-9a-f]+)\s*$/i.exec($('pasteAll').value);
    if (!m) {
        return;
    }
    $('port').value = m[1];
    $('token').value = m[2];
    $('pasteAll').value = '';
});

$('save').addEventListener('click', async () => {
    await chrome.storage.local.set({
        port: Number($('port').value) || 27121,
        token: $('token').value.trim(),
        debug: $('debug').checked
    });
    const saved = $('saved');
    saved.hidden = false;
    setTimeout(() => (saved.hidden = true), 1500);
});
