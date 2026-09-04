const $ = (id) => document.getElementById(id);

chrome.storage.local.get(['port', 'token', 'debug']).then((s) => {
    $('port').value = s.port || '';
    $('token').value = s.token || '';
    $('debug').checked = !!s.debug;
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
