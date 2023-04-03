// How long to wait between starting a single playback of the sound.
const WAKE_SIGNAL_INTERVAL_MSEC = 1000 * 60 * 18;

// Once we start a sound, how long should it play before stopping?
const WAKE_SIGNAL_DURATION_SEC = 10;
const WAKE_SIGNAL_DURATION_MSEC = WAKE_SIGNAL_DURATION_SEC * 1000;

const WAKE_SIGNAL_FREQ = 10;  // Hz

const TIMER_UPDATE_INTERVAL_MSEC = 15 * 1000;

const BUTTON_TEXT_START = "\u25B6 Start";
const BUTTON_TEXT_STOP = "\u25A0 Stop";

function appendStatus(text) {
  p = document.createElement("p");
  p.append(text);
  document.body.querySelector("#status").prepend(p);
}

class PeriodicCallback {
  constructor(fn, delayMsec) {
    this.fn_ = fn;
    this.delayMsec_ = delayMsec;
    this.nextUnixMsec_ = 0;
    this.callbackId_ = null;
  }

  get nextUnixMsec() { return this.nextUnixMsec_; }

  start() {
    if (this.callbackId_) return;
    this.callbackId_ = setInterval(() => this.callFn_(), this.delayMsec_);
    this.callFn_();
  }

  stop() {
    clearInterval(this.callbackId_);
    this.nextUnixMsec_ = 0;
    this.callbackId_ = null;
  }

  callFn_() {
    this.nextUnixMsec_ = Date.now() + this.delayMsec_;
    this.fn_()
  }
}

class WakeSignalController {
  constructor() {
    this.button_ = null;
    this.currentSoundStatus_ = null;

    this.audioCtx_ = null;

    this.abortController_ = new AbortController();
    this.playSoundPeriodicCallback_ = new PeriodicCallback(
        () => this.playSoundOnce_(), WAKE_SIGNAL_INTERVAL_MSEC);
    this.updateWaitingTextPeriodicCallback_ = new PeriodicCallback(
        () => this.updateWaitTimerText_(), TIMER_UPDATE_INTERVAL_MSEC);
  }

  mountTo(playPauseButtonSelector, currentSoundStatusSelector) {
    this.button_ = document.querySelector(playPauseButtonSelector);
    this.button_.textContent = BUTTON_TEXT_START;
    this.button_.onclick = () => this.startPeriodicAudio_();

    this.currentSoundStatus_ = document.querySelector(
        currentSoundStatusSelector);
  }

  playSoundOnce_() {
    if (!this.audioCtx_) return;

    this.currentSoundStatus_.className = "playing";
    appendStatus("PLAYING: " + (new Date()).toString());

    const signal = this.abortController_.signal;

    const oscillator = this.audioCtx_.createOscillator();
    oscillator.frequency.value = WAKE_SIGNAL_FREQ;
    oscillator.connect(this.audioCtx_.destination);
    oscillator.type = 'sine';
    oscillator.start();
    oscillator.stop(this.audioCtx_.currentTime + WAKE_SIGNAL_DURATION_SEC)
    oscillator.onended = () => {
      console.log('oscillator ended');
      oscillator.disconnect();
      if (signal.aborted) return;
      this.notifyEnteringWaitingState();
    };
    signal.addEventListener('abort', () => oscillator.stop());
  }

  notifyEnteringWaitingState() {
    this.currentSoundStatus_.className = "waiting";
    this.updateWaitTimerText_();
    appendStatus("STOPPED: " + (new Date()).toString());
    appendStatus(document.createElement("hr"));
    appendStatus("NEXT:    " + (new Date(
        this.playSoundPeriodicCallback_.nextUnixMsec)).toString())
  }

  updateWaitTimerText_() {
    const nextUnixMsec = this.playSoundPeriodicCallback_.nextUnixMsec;
    const minutes = Math.round(
        (nextUnixMsec - Date.now()) / 1000 / 60);
    this.currentSoundStatus_.setAttribute(
        'data-waiting-text', `WAITING for \u2248${minutes} minutes`);
  }

  startPeriodicAudio_() {
    if (!this.button_) {
      console.error('Cannot start periodic audio --' +
                    ' playPause Button not mounted.')
      return;
    }

    if (!this.audioCtx_) {
      this.audioCtx_ = new window.AudioContext();
    }
    this.abortController_.abort();
    this.abortController_ = new AbortController();

    this.playSoundPeriodicCallback_.start();
    this.updateWaitingTextPeriodicCallback_.start();

    this.button_.textContent = BUTTON_TEXT_STOP;
    this.button_.onclick = () => this.stopPeriodicAudio_();
  }

  stopPeriodicAudio_() {
    this.abortController_.abort();
    this.currentSoundStatus_.className = "standby";
    appendStatus("\n\nStopped periodic audio.");

    this.button_.textContent = BUTTON_TEXT_START;
    this.button_.onclick = () => this.startPeriodicAudio_();

    this.playSoundPeriodicCallback_.stop();
    this.updateWaitingTextPeriodicCallback_.stop();
  }
}

PING_FREQS = [
  440.00,  // A4
  // 523.25,  // C5
  554.37,  // C#5
  659.25,  // E5
];
PING_DURATION_SEC = 1;

class PingController {
  constructor({pan}) {
    this.audioCtx_ = null;
    this.abortPreviousPing_ = new AbortController();
    this.pan_ = pan;
  }

  mountTo(btnSelector) {
    document.querySelector(btnSelector).onclick =
        () => this.playPingSound();
  }

  playPingSound() {
    if (!this.audioCtx_) {
      this.audioCtx_ = new window.AudioContext();
    }

    this.abortPreviousPing_.abort();
    this.abortPreviousPing_ = new AbortController();

    const stopTime = this.audioCtx_.currentTime + PING_DURATION_SEC;

    const gainNode = this.audioCtx_.createGain();
    gainNode.connect(this.audioCtx_.destination);
    gainNode.gain.value = 0.95 / PING_FREQS.length;
    gainNode.gain.exponentialRampToValueAtTime(0.001, stopTime);

    const onEndedPromises = [];
    for (const freq of PING_FREQS) {
      onEndedPromises.push(this.createOscillator_(
          gainNode, freq, stopTime, this.abortPreviousPing_.signal));
    }
    Promise.allSettled(onEndedPromises).then(events => {
      gainNode.disconnect();
    });
  }

  // Returns a promise that's fulfilled when the new oscillator ends.
  createOscillator_(destinationNode, freq, stopTime, signal) {
    const oscillator = destinationNode.context.createOscillator();
    oscillator.frequency.value = freq;
    oscillator.type = 'sine';
    oscillator.start();
    oscillator.stop(stopTime);

    const panner = destinationNode.context.createStereoPanner();
    panner.pan.value = this.pan_;

    oscillator.connect(panner).connect(destinationNode);

    return new Promise((resolve, reject) => {
      oscillator.onended = (e) => {
        oscillator.disconnect();
        resolve(e);
      };
      signal.addEventListener('abort', () => {
        oscillator.stop();
        reject();
      });
    });
  }
};

const wakeSignalController = new WakeSignalController();
const pingCenterController = new PingController({"pan": 0});
const pingLeftController = new PingController({"pan": -1});
const pingRightController = new PingController({"pan": +1});
function onBodyLoad() {
  wakeSignalController.mountTo("#playPause", "#currentSound");
  pingCenterController.mountTo("#pingCenter");
  pingLeftController.mountTo("#pingLeft");
  pingRightController.mountTo("#pingRight");
}
