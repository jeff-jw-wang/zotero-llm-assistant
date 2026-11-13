// M4 experiment 1 — can Zotero receive an OAuth callback on 127.0.0.1?
//
// Paste into Zotero: Tools → Developer → Run JavaScript, then press Run.
// It contacts nothing outside this computer and stores nothing on disk.
// It tries two ways of listening and prints two test links to open in a
// browser. Run m4-callback-report.js afterwards to see the result and clean up.
//
//   Route A: an endpoint on Zotero's own local server (the one the browser
//            connector uses).
//   Route B: a small listener of our own on a separate port.

const CC = Components.classes;
const CI = Components.interfaces;

// Clean up a previous run, if any.
if (Zotero.__llmCallbackTest) {
  try { delete Zotero.Server.Endpoints[Zotero.__llmCallbackTest.pathA]; } catch (e) {}
  try { Zotero.__llmCallbackTest.socket.close(); } catch (e) {}
}

const state = (Zotero.__llmCallbackTest = {
  pathA: "/zotero-llm-assistant/auth/callback",
  pathB: "/auth/callback",
  portA: null,
  portB: null,
  receivedA: [],
  receivedB: [],
  errors: [],
  socket: null,
  listener: null,
});

const page = (route) =>
  "<!doctype html><meta charset='utf-8'><title>Callback received</title>" +
  "<h1>Route " + route + ": Zotero received this request.</h1>" +
  "<p>You can close this tab and go back to Zotero.</p>";

// ---- Route A: Zotero's own server -----------------------------------------
try {
  const Endpoint = function () {};
  Endpoint.prototype = {
    supportedMethods: ["GET"],
    init: function (options) {
      let query = {};
      try { query = Object.assign({}, options.query); } catch (e) {}
      state.receivedA.push({ pathname: String(options.pathname), query });
      return [200, "text/html", page("A")];
    },
  };
  Zotero.Server.Endpoints[state.pathA] = Endpoint;
  state.portA = Zotero.Prefs.get("httpServer.port");
} catch (e) {
  state.errors.push("Route A setup failed: " + e);
}

// ---- Route B: our own loopback listener -----------------------------------
try {
  const socket = CC["@mozilla.org/network/server-socket;1"].createInstance(
    CI.nsIServerSocket,
  );
  try {
    socket.init(1455, true, 5); // true = loopback only
  } catch (e) {
    socket.init(-1, true, 5); // 1455 is taken: let the system pick a port
  }

  state.listener = {
    onSocketAccepted: function (_server, transport) {
      try {
        const input = transport
          .openInputStream(0, 0, 0)
          .QueryInterface(CI.nsIAsyncInputStream);
        const output = transport.openOutputStream(
          CI.nsITransport.OPEN_BLOCKING,
          0,
          0,
        );
        input.asyncWait(
          {
            onInputStreamReady: function (stream) {
              try {
                const reader = CC[
                  "@mozilla.org/scriptableinputstream;1"
                ].createInstance(CI.nsIScriptableInputStream);
                reader.init(stream);
                let request = "";
                try { request = reader.read(reader.available()); } catch (e) {}
                const requestLine = request.split("\r\n")[0] || "";
                const target = requestLine.split(" ")[1] || "";
                let query = {};
                let pathname = target;
                try {
                  const url = new URL(target, "http://127.0.0.1");
                  pathname = url.pathname;
                  for (const [k, v] of url.searchParams) query[k] = v;
                } catch (e) {}
                // Browsers also ask for /favicon.ico; record only the callback.
                const isCallback = pathname === state.pathB;
                if (isCallback) state.receivedB.push({ pathname, query });
                const body = isCallback ? page("B") : "";
                const response =
                  "HTTP/1.1 " + (isCallback ? "200 OK" : "404 Not Found") + "\r\n" +
                  "Content-Type: text/html; charset=utf-8\r\n" +
                  "Content-Length: " + body.length + "\r\n" +
                  "Connection: close\r\n\r\n" +
                  body;
                output.write(response, response.length);
                output.close();
                stream.close();
              } catch (e) {
                state.errors.push("Route B request failed: " + e);
              }
            },
          },
          0,
          0,
          Services.tm.mainThread,
        );
      } catch (e) {
        state.errors.push("Route B accept failed: " + e);
      }
    },
    onStopListening: function () {},
  };
  socket.asyncListen(state.listener);
  state.socket = socket;
  state.portB = socket.port;
} catch (e) {
  state.errors.push("Route B setup failed: " + e);
}

const q = "?code=test-code&state=test-state&client_id=oaiapp_test";
return [
  "Listening. Open BOTH links in your normal web browser, then run m4-callback-report.js.",
  "",
  "Route A: " +
    (state.portA
      ? "http://127.0.0.1:" + state.portA + state.pathA + q
      : "not available"),
  "Route B: " +
    (state.portB
      ? "http://127.0.0.1:" + state.portB + state.pathB + q
      : "not available"),
  "",
  state.errors.length ? "Setup problems:\n" + state.errors.join("\n") : "No setup problems.",
].join("\n");
