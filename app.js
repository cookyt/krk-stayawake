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
    this.isCurrentlyRunning_ = false;
  }

  get isCurrentlyRunning() { return this.isCurrentlyRunning_; }

  get nextUnixMsec() { return this.nextUnixMsec_; }

  get delayMsec() { return this.delayMsec_; }
  get delayMinutes() { return Math.floor(this.delayMsec_ / 1000 / 60); }

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

  async callFn_() {
    this.nextUnixMsec_ = Date.now() + this.delayMsec_;

    // Don't allow overlapping executions if previous call takes too long.
    if (this.isCurrentlyRunning_) {
      throw new Error("Refusing overlapping invocation of PeriodicClosure",
                      this.fn_, this.callbackId_);
    }
    console.debug("currentlyRunning = true", this.fn_);
    this.isCurrentlyRunning_ = true;
    try {
      await this.fn_();
    } finally {
      console.debug("currentlyRunning = false", this.fn_);
      this.isCurrentlyRunning_ = false;
    }
  }
}

class WakeSignalController {
  constructor() {
    this.button_ = null;
    this.currentSoundStatus_ = null;
    this.currentSoundStatusBar_ = null;

    this.audioCtx_ = null;

    this.abortController_ = new AbortController();
    this.playSoundPeriodicCallback_ = new PeriodicCallback(
        () => this.playSoundCallbackFn_(), WAKE_SIGNAL_INTERVAL_MSEC);
    this.updateWaitingTextPeriodicCallback_ = new PeriodicCallback(
        () => this.updateWaitTimerText_(), TIMER_UPDATE_INTERVAL_MSEC);
  }

  mountTo(playPauseButtonSelector, currentSoundStatusSelector) {
    this.button_ = document.querySelector(playPauseButtonSelector);
    this.button_.textContent = BUTTON_TEXT_START;
    this.button_.onclick = () => this.startPeriodicAudio_();

    this.currentSoundStatus_ = document.querySelector(
        currentSoundStatusSelector);
    this.currentSoundStatusBar_ =
        this.currentSoundStatus_.querySelector("progress");
    this.currentSoundStatusBar_.max =
        this.playSoundPeriodicCallback_.delayMinutes;
  }

  async playSoundCallbackFn_() {
    this.currentSoundStatus_.className = "playing";
    this.currentSoundStatusBar_.value =
        this.playSoundPeriodicCallback_.delayMinutes;
    appendStatus("PLAYING: " + (new Date()).toString());
    await this.playSoundOnce_();
    this.notifyEnteringWaitingState();
  }

  playSoundOnce_() {
    if (!this.audioCtx_) throw new Error("Missing AudioContext");

    const signal = this.abortController_.signal;

    return new Promise((resolve, reject) => {
      const oscillator = this.audioCtx_.createOscillator();
      oscillator.frequency.value = WAKE_SIGNAL_FREQ;
      oscillator.connect(this.audioCtx_.destination);
      oscillator.type = 'sine';
      oscillator.start();
      oscillator.stop(this.audioCtx_.currentTime + WAKE_SIGNAL_DURATION_SEC)
      oscillator.onended = () => {
        console.debug('oscillator ended');
        oscillator.disconnect();
        if (signal.aborted) return;
        resolve();
      };
      signal.addEventListener('abort', () => {
        oscillator.stop();
        reject('Aborted');
      });
    });
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
    console.debug("Updating wait timer");
    if (this.currentSoundStatus_.className == "playing") {
      console.debug("Skipping wait timer update as sound is running");
      return;
    }
    const nextUnixMsec = this.playSoundPeriodicCallback_.nextUnixMsec;
    const minutes = Math.round((nextUnixMsec - Date.now()) / 1000 / 60);
    this.currentSoundStatusBar_.value =
        minutes - this.playSoundPeriodicCallback_.delayMinutes;
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

const NOTES = {
  A4: 440.00,
  C5: 523.25,
  Cs5: 554.37,
  E5: 659.25,
};
const CHORD_A5    = [ NOTES.A4, NOTES.E5 ];
const CHORD_A_MIN = [ NOTES.A4, NOTES.C5, NOTES.E5 ];
const CHORD_A_MAJ = [ NOTES.A4, NOTES.Cs5, NOTES.E5 ];

const PAN = {
  CENTER: 0,
  LEFT: -1,
  RIGHT: +1,
};

class PingController {
  constructor({pan = PAN.CENTER, freqs = CHORD_A5,
               ping_duration_secs = 1} = {}) {
    this.audioCtx_ = null;
    this.abortPreviousPing_ = new AbortController();
    this.pan_ = pan;
    this.freqs_ = freqs;
    this.ping_duration_secs_ = ping_duration_secs;
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

    const stopTime = this.audioCtx_.currentTime + this.ping_duration_secs_;

    const gainNode = this.audioCtx_.createGain();
    gainNode.connect(this.audioCtx_.destination);
    gainNode.gain.value = 0.95 / this.freqs_.length;
    gainNode.gain.exponentialRampToValueAtTime(0.001, stopTime);

    const onEndedPromises = [];
    for (const freq of this.freqs_) {
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

// Controllers are globals so that it's easier to debug them with dev tools.
const wakeSignalController = new WakeSignalController();
const pingCenterController = new PingController();
const pingLeftController = new PingController(
    {"pan": PAN.LEFT, freqs: CHORD_A_MIN});
const pingRightController = new PingController(
    {"pan": PAN.RIGHT, freqs: CHORD_A_MAJ});

function onBodyLoad() {
  wakeSignalController.mountTo("#playPause", "#currentSound");
  pingCenterController.mountTo("#pingCenter");
  pingLeftController.mountTo("#pingLeft");
  pingRightController.mountTo("#pingRight");
}
