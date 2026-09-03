"use strict";

const assert = require("node:assert/strict");
const PopupSound = require("../src/popup-sound.js");

let assertions = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

function fakeAudioContext(log, options = {}) {
  return function FakeAudioContext() {
    log.push(["construct"]);
    return {
      state: options.state || "running",
      currentTime: 5,
      destination: { id: "out" },
      resume() {
        log.push(["resume"]);
        return Promise.resolve();
      },
      close() {
        log.push(["close"]);
      },
      createOscillator() {
        const oscillator = {
          type: "",
          frequency: {
            setValueAtTime: (value, at) => log.push(["freq", value, at])
          },
          connect: (node) => log.push(["osc-connect", node.id || "gain"]),
          start: (at) => log.push(["start", at]),
          stop: (at) => log.push(["stop", at])
        };
        return oscillator;
      },
      createGain() {
        return {
          gain: {
            setValueAtTime: (value, at) => log.push(["gain", value, at]),
            exponentialRampToValueAtTime: (value, at) =>
              log.push(["ramp", value, at])
          },
          id: "gain",
          connect: (node) => log.push(["gain-connect", node.id])
        };
      }
    };
  };
}

function main() {
  check(typeof PopupSound.createController, "function");
  check(PopupSound.TONES.length, 2, "chime is a two-note rise");

  {
    const log = [];
    const controller = PopupSound.createController({
      getSettings: () => ({ completionSound: false }),
      AudioContext: fakeAudioContext(log)
    });
    check(controller.isEnabled(), false);
    check(controller.playCompletion(), false, "opt-out setting stays silent");
    check(log, [], "no audio context is created while disabled");
  }

  {
    const log = [];
    const controller = PopupSound.createController({
      getSettings: () => ({ completionSound: true }),
      AudioContext: fakeAudioContext(log)
    });
    check(controller.isEnabled(), true);
    check(controller.playCompletion(), true);
    check(
      log.filter((entry) => entry[0] === "construct").length,
      1,
      "context is created lazily"
    );
    check(
      log
        .filter((entry) => entry[0] === "start")
        .map((entry) => Number(entry[1].toFixed(3))),
      [5.01, 5.11],
      "both notes are scheduled ahead of the clock"
    );
    check(
      log.filter((entry) => entry[0] === "freq").map((entry) => entry[1]),
      [880, 1318.51]
    );
    check(
      log.filter((entry) => entry[0] === "gain-connect").every(
        (entry) => entry[1] === "out"
      ),
      true,
      "notes reach the destination"
    );
    controller.playCompletion();
    check(
      log.filter((entry) => entry[0] === "construct").length,
      1,
      "context is reused across chimes"
    );
    controller.close();
    check(log.filter((entry) => entry[0] === "close").length, 1);
  }

  {
    const log = [];
    const controller = PopupSound.createController({
      getSettings: () => ({ completionSound: true }),
      AudioContext: fakeAudioContext(log, { state: "suspended" })
    });
    controller.playChime();
    check(
      log.some((entry) => entry[0] === "resume"),
      true,
      "a suspended popup context is resumed"
    );
  }

  {
    const controller = PopupSound.createController({
      getSettings: () => ({ completionSound: true }),
      AudioContext: null
    });
    check(controller.playChime(), false, "missing Web Audio is not fatal");
  }

  {
    const controller = PopupSound.createController({
      getSettings: () => {
        throw new Error("settings unavailable");
      },
      AudioContext: fakeAudioContext([])
    });
    check(controller.isEnabled(), false);
    check(controller.playCompletion(), false);
  }

  {
    const controller = PopupSound.createController({
      getSettings: () => ({ completionSound: true }),
      AudioContext: function Broken() {
        throw new Error("blocked");
      }
    });
    check(controller.playChime(), false, "context construction failure is caught");
  }

  console.log(`popup sound: ${assertions} assertions passed`);
}

main();
