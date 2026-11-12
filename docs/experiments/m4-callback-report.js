// M4 experiment 1, second half — report what arrived, then stop listening.
//
// Paste into Zotero: Tools → Developer → Run JavaScript, press Run, and copy
// the whole output back. Nothing in it is secret: the values are the test
// values from the links.

const state = Zotero.__llmCallbackTest;
if (!state) {
  return "Nothing to report: run m4-callback-start.js first.";
}

const verdict = (received) => {
  if (received.length === 0) return "NOT RECEIVED";
  const q = received[received.length - 1].query || {};
  const ok =
    q.code === "test-code" &&
    q.state === "test-state" &&
    q.client_id === "oaiapp_test";
  return ok ? "RECEIVED, all three values intact" : "RECEIVED, but values differ";
};

const report = {
  zoteroVersion: Zotero.version,
  platform: Zotero.platform,
  routeA: {
    verdict: verdict(state.receivedA),
    port: state.portA,
    path: state.pathA,
    received: state.receivedA,
  },
  routeB: {
    verdict: verdict(state.receivedB),
    port: state.portB,
    path: state.pathB,
    received: state.receivedB,
  },
  errors: state.errors,
};

// Stop listening.
try { delete Zotero.Server.Endpoints[state.pathA]; } catch (e) {}
try { state.socket.close(); } catch (e) {}
delete Zotero.__llmCallbackTest;

return JSON.stringify(report, null, 2);
