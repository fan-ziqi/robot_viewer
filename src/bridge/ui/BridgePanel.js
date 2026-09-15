/**
 * BridgePanel - connection UI for the local joint stream.
 *
 * Built in JS rather than in index.html so the whole feature stays in one
 * folder; it still reuses the floating-panel markup so PanelManager can drag
 * and resize it like every other panel.
 */
import { RemoteBridge, BRIDGE_DEFAULT_URL } from '../RemoteBridge.js';
import './bridge-panel.css';

const STORAGE_KEY = 'robot-viewer.bridge';

export class BridgePanel {
    constructor({ poseController, panelManager }) {
        this.bridge = new RemoteBridge(poseController);
        this.panelManager = panelManager;

        this.createUI();
        this.bindEvents();
        this.restoreSettings();

        this.bridge.subscribe((event) => {
            if (event.type === 'status') this.renderStatus();
            else if (event.type === 'stats') this.renderStats();
            else if (event.type === 'mapping') this.renderMapping();
        });

        this.renderStatus();
        this.renderStats();
        this.renderMapping();
        this.renderHelp();
    }

    createUI() {
        const host = document.getElementById('floating-joints-panel')?.parentElement || document.body;

        this.root = document.createElement('div');
        this.root.id = 'floating-bridge-panel';
        this.root.className = 'floating-panel';
        this.root.style.display = 'none';
        this.root.innerHTML = `
            <div class="floating-panel-header">
                <span data-i18n="bridgeTitle">Local Bridge</span>
                <button class="panel-close-btn" data-panel="floating-bridge-panel">✕</button>
            </div>
            <div class="floating-panel-content bridge-content">
                <div class="bridge-status">
                    <span class="bridge-dot"></span>
                    <span class="bridge-status-text"></span>
                </div>

                <label class="bridge-field">
                    <span data-i18n="bridgeUrl">Server address</span>
                    <input type="text" class="bridge-input" data-bridge="url" spellcheck="false"
                           placeholder="${BRIDGE_DEFAULT_URL}">
                </label>

                <label class="bridge-field">
                    <span data-i18n="bridgeToken">Token (optional)</span>
                    <input type="password" class="bridge-input" data-bridge="token" spellcheck="false"
                           autocomplete="off">
                </label>

                <div class="bridge-actions">
                    <button class="control-button bridge-connect" data-bridge-action="toggle"></button>
                    <label class="bridge-checkbox">
                        <input type="checkbox" data-bridge="auto-reconnect" checked>
                        <span data-i18n="bridgeAutoReconnect">Auto reconnect</span>
                    </label>
                </div>

                <div class="bridge-stats">
                    <div><span data-i18n="bridgeRateIn">In</span><b class="bridge-rate-in">0</b> Hz</div>
                    <div><span data-i18n="bridgeRateOut">Applied</span><b class="bridge-rate-out">0</b> Hz</div>
                    <div><span data-i18n="bridgeDropped">Coalesced</span><b class="bridge-dropped">0</b></div>
                </div>

                <div class="bridge-mapping"></div>

                <div class="bridge-help-section">
                    <button type="button" class="bridge-help-toggle" data-bridge-action="help">
                        <span class="bridge-caret">▸</span>
                        <span data-i18n="bridgeHelp">How to use</span>
                    </button>
                    <div class="bridge-help" hidden>
                        <ol class="bridge-steps">
                            <li data-i18n="bridgeHelpStep1"></li>
                            <li data-i18n="bridgeHelpStep2"></li>
                            <li data-i18n="bridgeHelpStep3"></li>
                        </ol>
                        <div class="bridge-code-head">
                            <span>bridge.py</span>
                            <button type="button" class="bridge-copy" data-bridge-action="copy"></button>
                        </div>
                        <pre class="bridge-code"><code></code></pre>
                        <p class="bridge-help-note" data-i18n="bridgeHelpNote"></p>
                    </div>
                </div>
            </div>
        `;
        host.appendChild(this.root);

        this.urlInput = this.root.querySelector('[data-bridge="url"]');
        this.tokenInput = this.root.querySelector('[data-bridge="token"]');
        this.autoReconnectInput = this.root.querySelector('[data-bridge="auto-reconnect"]');
        this.connectButton = this.root.querySelector('.bridge-connect');
        this.statusText = this.root.querySelector('.bridge-status-text');
        this.statusDot = this.root.querySelector('.bridge-dot');
        this.mappingBox = this.root.querySelector('.bridge-mapping');
        this.helpBox = this.root.querySelector('.bridge-help');
        this.helpToggle = this.root.querySelector('.bridge-help-toggle');
        this.codeBox = this.root.querySelector('.bridge-code code');
        this.copyButton = this.root.querySelector('.bridge-copy');

        this.panelManager?.registerPanel('floating-bridge-panel');
        window.i18n?.updatePageLanguage();
    }

    bindEvents() {
        // Opening, closing and the position reset come from UIController's shared
        // panel wiring, so this panel animates exactly like Files and Structure.
        this.toggleButton = document.getElementById('toggle-bridge-panel');
        this.connectButton.addEventListener('click', () => this.toggleConnection());

        this.urlInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') this.toggleConnection();
        });
        this.autoReconnectInput.addEventListener('change', () => {
            this.bridge.autoReconnect = this.autoReconnectInput.checked;
            this.saveSettings();
        });

        this.helpToggle.addEventListener('click', () => {
            this.helpOpen = !this.helpOpen;
            this.renderHelp();
            this.saveSettings();
        });
        this.copyButton.addEventListener('click', () => this.copySnippet());
    }

    /**
     * The example server, pre-filled with the address this page is served from -
     * the Origin check only works if it matches, and a hand-edited constant is
     * the easiest thing to get wrong.
     */
    snippet() {
        return `# pip install "websockets>=14"
import asyncio, json, math, struct, websockets

ORIGINS = {"${location.origin}"}  # ${this.t('bridgeSnippetOrigin', 'this page; must be checked')}

async def handler(ws):
    if ws.request.headers.get("Origin") not in ORIGINS:
        return await ws.close(1008)
    await ws.send(json.dumps({"type": "hello", "joints": []}))
    joints = json.loads(await ws.recv())["joints"]  # ${this.t('bridgeSnippetJoints', 'joints of the loaded model')}
    await ws.send(json.dumps({"type": "hello", "joints": joints}))
    t = 0.0
    while True:
        values = [0.5 * math.sin(t + i) for i in range(len(joints))]  # ${this.t('bridgeSnippetValues', 'replace with real data')}
        await ws.send(struct.pack(f"<{len(joints)}f", *values))
        t += 0.02
        await asyncio.sleep(0.02)

async def main():
    async with websockets.serve(handler, "127.0.0.1", 9090):
        await asyncio.Future()

asyncio.run(main())`;
    }

    /**
     * navigator.clipboard exists only in a secure context, which rules out the
     * two ordinary ways to run this viewer locally: opening the built page over
     * file:// and reaching a dev server over a plain-http LAN address. Fall back
     * to the legacy selection copy there, and if even that is refused, leave the
     * snippet selected so Ctrl/Cmd+C finishes the job.
     */
    async copySnippet() {
        const text = this.snippet();
        let copied = false;

        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                copied = true;
            } catch {
                copied = false;   // denied, or the document lost focus
            }
        }
        if (!copied) copied = this.copyViaSelection(text);
        if (!copied) this.selectSnippet();

        this.copyButton.textContent = copied
            ? this.t('bridgeCopied', 'Copied')
            : this.t('bridgeCopyFailed', 'Press Ctrl/Cmd+C');

        clearTimeout(this.copyResetTimer);
        this.copyResetTimer = setTimeout(() => {
            this.copyButton.textContent = this.t('bridgeCopy', 'Copy');
        }, 1600);
    }

    /** document.execCommand('copy'), which works outside a secure context. */
    copyViaSelection(text) {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        // Off-screen but still selectable - display:none would leave nothing to copy.
        area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;';
        document.body.appendChild(area);

        const selection = document.getSelection();
        const previous = selection?.rangeCount > 0 ? selection.getRangeAt(0) : null;

        area.select();
        area.setSelectionRange(0, text.length);

        let copied = false;
        try {
            copied = document.execCommand('copy');
        } catch {
            copied = false;
        }

        area.remove();
        if (previous) {
            selection.removeAllRanges();
            selection.addRange(previous);
        }
        return copied;
    }

    /** Last resort: hand the user a ready-made selection to press Ctrl/Cmd+C on. */
    selectSnippet() {
        const selection = document.getSelection();
        if (!selection) return;
        const range = document.createRange();
        range.selectNodeContents(this.codeBox);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    toggleConnection() {
        if (this.bridge.status === 'disconnected' || this.bridge.status === 'error') {
            this.bridge.autoReconnect = this.autoReconnectInput.checked;
            this.bridge.connect(this.urlInput.value.trim() || BRIDGE_DEFAULT_URL, this.tokenInput.value);
            this.saveSettings();
        } else {
            this.bridge.disconnect();
        }
    }

    // ------------------------------------------------------------- rendering

    t(key, fallback) {
        return window.i18n?.t(key) || fallback;
    }

    renderStatus() {
        const { status, statusDetail } = this.bridge;
        const labels = {
            disconnected: this.t('bridgeDisconnected', 'Disconnected'),
            connecting: this.t('bridgeConnecting', 'Connecting…'),
            connected: this.t('bridgeConnected', 'Connected'),
            error: this.t('bridgeError', 'Error')
        };
        this.statusText.textContent = statusDetail
            ? `${labels[status]} · ${statusDetail}`
            : labels[status];
        this.statusDot.dataset.status = status;
        this.connectButton.textContent = (status === 'connected' || status === 'connecting')
            ? this.t('bridgeDisconnect', 'Disconnect')
            : this.t('bridgeConnect', 'Connect');
        this.connectButton.classList.toggle('active', status === 'connected');
        this.toggleButton?.classList.toggle('bridge-live', status === 'connected');
    }

    renderStats() {
        const { rateIn, rateOut, dropped } = this.bridge.stats;
        this.root.querySelector('.bridge-rate-in').textContent = rateIn;
        this.root.querySelector('.bridge-rate-out').textContent = rateOut;
        this.root.querySelector('.bridge-dropped').textContent = dropped;
    }

    renderHelp() {
        this.helpBox.hidden = !this.helpOpen;
        this.helpToggle.querySelector('.bridge-caret').textContent = this.helpOpen ? '▾' : '▸';
        this.codeBox.textContent = this.snippet();
        this.copyButton.textContent = this.t('bridgeCopy', 'Copy');
    }

    renderMapping() {
        const { matched, unknown, undriven, total } = this.bridge.mapping;
        if (!this.bridge.remoteJoints.length) {
            this.mappingBox.innerHTML =
                `<div class="bridge-hint">${this.t('bridgeAwaitingHello', 'Waiting for the server to declare its joints.')}</div>`;
            return;
        }

        const rows = [
            `<div class="bridge-map-row ok">
                <span>${this.t('bridgeMatched', 'Driven joints')}</span>
                <b>${matched.length} / ${total}</b>
             </div>`
        ];
        if (unknown.length) {
            rows.push(`<div class="bridge-map-row warn">
                <span>${this.t('bridgeUnknown', 'Not in model')}</span>
                <b title="${unknown.join(', ')}">${unknown.length}</b>
             </div>
             <div class="bridge-names">${unknown.join(', ')}</div>`);
        }
        if (undriven.length) {
            rows.push(`<div class="bridge-map-row muted">
                <span>${this.t('bridgeUndriven', 'Not streamed')}</span>
                <b title="${undriven.join(', ')}">${undriven.length}</b>
             </div>`);
        }
        this.mappingBox.innerHTML = rows.join('');
    }

    // -------------------------------------------------------------- settings

    saveSettings() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                url: this.urlInput.value.trim(),
                autoReconnect: this.autoReconnectInput.checked,
                helpOpen: this.helpOpen
            }));
        } catch {
            // Private browsing or a full quota - the panel still works, it just forgets.
        }
    }

    restoreSettings() {
        let saved = {};
        try {
            saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        } catch {
            saved = {};
        }
        this.urlInput.value = saved.url || BRIDGE_DEFAULT_URL;
        this.autoReconnectInput.checked = saved.autoReconnect !== false;
        // Expanded until the user collapses it, so the setup steps are the first
        // thing a newcomer sees rather than something they have to go looking for.
        this.helpOpen = saved.helpOpen !== false;
        this.bridge.autoReconnect = this.autoReconnectInput.checked;
    }

    /** Re-render the labels this panel builds in JS, which data-i18n cannot reach. */
    refreshLanguage() {
        this.renderStatus();
        this.renderMapping();
        this.renderHelp();
    }
}
