const assert = require("node:assert/strict");
const test = require("node:test");
const { createServiceRestartHandler } = require("../runtime/http/service-control.cjs");

function makeResponseRecorder() {
  return {
    body: "",
    headers: {},
    status: 0,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(body) {
      this.body = String(body || "");
    },
  };
}

function responseJson(res) {
  return JSON.parse(res.body || "{}");
}

test("restart endpoint accepts a freshly verified password and returns the old instance id", async () => {
  let restartCount = 0;
  const handler = createServiceRestartHandler({
    instanceId: "old-instance",
    requestRestart: () => {
      restartCount += 1;
      return true;
    },
    restartSupported: true,
    verifyAccessPasswordRequest: async () => true,
  });
  const res = makeResponseRecorder();

  await handler({ method: "POST" }, res);

  assert.equal(res.status, 202);
  assert.deepEqual(responseJson(res), {
    ok: true,
    restarting: true,
    instanceId: "old-instance",
  });
  assert.equal(restartCount, 1);
});

test("restart endpoint never schedules a restart after password verification fails", async () => {
  let restartCount = 0;
  const handler = createServiceRestartHandler({
    instanceId: "old-instance",
    requestRestart: () => {
      restartCount += 1;
      return true;
    },
    restartSupported: true,
    verifyAccessPasswordRequest: async (_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Invalid password" }));
      return false;
    },
  });
  const res = makeResponseRecorder();

  await handler({ method: "POST" }, res);

  assert.equal(res.status, 401);
  assert.equal(restartCount, 0);
});

test("restart endpoint refuses to stop an unsupervised gateway", async () => {
  let verified = false;
  const handler = createServiceRestartHandler({
    instanceId: "old-instance",
    requestRestart: () => true,
    restartSupported: false,
    verifyAccessPasswordRequest: async () => {
      verified = true;
      return true;
    },
  });
  const res = makeResponseRecorder();

  await handler({ method: "POST" }, res);

  assert.equal(res.status, 503);
  assert.equal(responseJson(res).error, "Service restart is unavailable");
  assert.equal(verified, false);
});

test("restart endpoint reports a restart that is already pending", async () => {
  const handler = createServiceRestartHandler({
    instanceId: "old-instance",
    requestRestart: () => false,
    restartSupported: true,
    verifyAccessPasswordRequest: async () => true,
  });
  const res = makeResponseRecorder();

  await handler({ method: "POST" }, res);

  assert.equal(res.status, 409);
  assert.equal(responseJson(res).error, "Service restart is already pending");
});
