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

// Error thrown when an abort signal is triggered before an audio node finishes
// its job.
class AbortedError extends Error {};

// Human-readable constants for a StereoPannerNode's param value.
const PAN = {
  CENTER: 0,
  LEFT: -1,
  RIGHT: +1,
};

// Creates and starts a new oscillator connected to the provided node. Returned
// promise resolves when the oscillator finishes, and rejects if the abort
// signal is triggered.
async function startOscillator(destinationNode, freq, stopTime, abortSignal,
                               {type = 'sine', panValue} = {}) {
  const oscillator = destinationNode.context.createOscillator();
  oscillator.frequency.value = freq;
  oscillator.type = type;
  oscillator.start();
  oscillator.stop(stopTime);

  if (panValue !== undefined) {
    const panner = destinationNode.context.createStereoPanner();
    panner.pan.value = panValue;
    oscillator.connect(panner).connect(destinationNode);
  } else {
    oscillator.connect(destinationNode);
  }

  return new Promise((resolve, reject) => {
    oscillator.onended = (e) => {
      console.debug(`${freq}Hz oscillator ended`);
      oscillator.disconnect();
      resolve(e);
    };
    abortSignal.addEventListener('abort', () => {
      oscillator.stop();
      reject(new AbortedError(`${freq}Hz oscillator aborted.`));
    });
  });
}

// Error raised when a PeriodicCallback attempts to trigger, but finds that a
// prior invocation hasn't finished yet.
class OverlappingInvocationError extends Error {};

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
  get delaySecs() { return Math.floor(this.delayMsec_ / 1000); }

  // Starts the callback running and invokes it now.
  start() {
    if (this.callbackId_) return;
    this.callbackId_ = setInterval(() => this.callFn_(), this.delayMsec_);
    this.callFn_();
  }

  // Prevents any new callbacks from being scheduled. However, does not
  // abort callbacks currently in-progress.
  stop() {
    clearInterval(this.callbackId_);
    this.nextUnixMsec_ = 0;
    this.callbackId_ = null;
  }

  async callFn_() {
    this.nextUnixMsec_ = Date.now() + this.delayMsec_;

    // Don't allow overlapping executions if previous call takes too long.
    if (this.isCurrentlyRunning_) {
      throw new OverlappingInvocationError(
          "Refusing overlapping invocation of PeriodicClosure",
          this.fn_, this.callbackId_);
    }
    console.debug("currentlyRunning=true", this.fn_);
    this.isCurrentlyRunning_ = true;
    try {
      await this.fn_();
    } finally {
      console.debug("currentlyRunning=false", this.fn_);
      this.isCurrentlyRunning_ = false;
    }
  }
}

/**
 * @callback DestinationNodeFactory
 * @returns {AudioNode}
 */

class WakeSignalController {
  /**
   * @param {DestinationNodeFactory} destinationNodeFactory
   */
  constructor(destinationNodeFactory) {
    this.button_ = null;
    this.currentSoundStatus_ = null;
    this.currentSoundStatusBar_ = null;

    this.destinationNodeFactory_ = destinationNodeFactory;

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
        this.playSoundPeriodicCallback_.delaySecs;
  }

  async playSoundCallbackFn_() {
    this.currentSoundStatus_.className = "playing";
    this.currentSoundStatusBar_.value =
        this.playSoundPeriodicCallback_.delaySecs;
    appendStatus("PLAYING: " + (new Date()).toString());
    try {
      await this.playSoundOnce_();
    } catch (err) {
      // Can happen if user decides to stop audio in the middle of the sound
      // being played. Don't enter the "waiting" state, in this case.
      if (err instanceof AbortedError) return;
      throw err;
    }
    this.notifyEnteringWaitingState();
  }

  async playSoundOnce_() {
    const destination = await this.destinationNodeFactory_();
    if (!destination) throw new Error("Missing AudioContext");

    const currentTime = destination.context.currentTime;

    // Don't start/stop the signal abruptly. Ramp up then down gradually to
    // avoid edge effects.
    const gainNode = destination.context.createGain();
    gainNode.gain.value = 0;
    gainNode.gain.linearRampToValueAtTime(
        1, currentTime + WAKE_SIGNAL_DURATION_SEC / 5);
    gainNode.gain.setValueAtTime(
        1, currentTime + WAKE_SIGNAL_DURATION_SEC * (4 / 5));
    gainNode.gain.linearRampToValueAtTime(
        0, currentTime + WAKE_SIGNAL_DURATION_SEC);
    gainNode.connect(destination);

    return startOscillator(
        gainNode, WAKE_SIGNAL_FREQ,
        currentTime + WAKE_SIGNAL_DURATION_SEC,
        this.abortController_.signal);
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
    const seconds = Math.round((nextUnixMsec - Date.now()) / 1000);
    this.currentSoundStatusBar_.value =
        this.playSoundPeriodicCallback_.delaySecs - seconds;

    const minutes = Math.round(seconds / 60);
    this.currentSoundStatus_.setAttribute(
        'data-waiting-text', `WAITING for \u2248${minutes} minutes`);
  }

  startPeriodicAudio_() {
    if (!this.button_) {
      console.error('Cannot start periodic audio --' +
                    ' playPause Button not mounted.')
      return;
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

class PingController {
  /**
   * @param {DestinationNodeFactory} destinationNodeFactory
   */
  constructor(destinationNodeFactory, {pan = PAN.CENTER, freqs = CHORD_A5,
                                       ping_duration_secs = 1} = {}) {
    this.destinationNodeFactory_ = destinationNodeFactory;
    this.abortPreviousPing_ = new AbortController();
    this.pan_ = pan;
    this.freqs_ = freqs;
    this.ping_duration_secs_ = ping_duration_secs;
  }

  mountTo(btnSelector) {
    document.querySelector(btnSelector).onclick =
        () => this.playPingSound();
  }

  async playPingSound() {
    const destination = await this.destinationNodeFactory_();
    if (!destination) {
      throw new Error("Failed to initialize AudioContext");
    }

    const audioCtx = destination.context;

    this.abortPreviousPing_.abort();
    this.abortPreviousPing_ = new AbortController();

    const stopTime = audioCtx.currentTime + this.ping_duration_secs_;

    const gainNode = audioCtx.createGain();
    gainNode.connect(destination);
    gainNode.gain.value = 0.95 / this.freqs_.length;
    gainNode.gain.exponentialRampToValueAtTime(0.001, stopTime);

    const onEndedPromises = [];
    for (const freq of this.freqs_) {
      onEndedPromises.push(startOscillator(
          gainNode, freq, stopTime, this.abortPreviousPing_.signal,
          {panValue: this.pan_}));
    }
    await Promise.allSettled(onEndedPromises);
    gainNode.disconnect();
  }
};

// A few util functions for manipulating SinkIds.
const SinkIds = {
  // A special sentinel value, rather than a real ID. Tells us we need to
  // configure the audioContext not to send _any_ audio out.
  NONE: 'none',
  isNone: (s) => {
    return s === 'none' ||
           (s instanceof Object && s.type === 'none')
  },

  // The default audio device which the OS has given the browser.
  DEFAULT: '',
  isDefault: (s) => {
    return s === '' || s === 'default' || s === null;
  },

  areSame: (a, b) => {
    return (a === b) ||
           (SinkIds.isNone(a) && SinkIds.isNone(b)) ||
           (SinkIds.isDefault(a) && SinkIds.isDefault(b));
  }
};

// Provides access to the AudioContext and will mount to a drop-down menu
// to allow users to switch which output device audio is sent to.
//
// Note, in order to populate the list of audio devices (aside from the default
// device and the null device), we must request microphone access. Since I
// don't want to request that when the page first opens, we mount a "refresh"
// button which requests the permission and then updates the selection box.
// This way, the app is still usable without giving mic access.
//
// See: https://developer.chrome.com/blog/audiocontext-setsinkid/
class AudioOutputDeviceSelectController {
  constructor() {
    this.deviceSelector_ = null;
    this.selectedDevice_ = SinkIds.DEFAULT;
    this.audioCtx_ = null;
  }

  mountTo(containerDivCssSelector, refreshButtonCssSelector,
          deviceSelectorCssSelector) {
    if ('setSinkId' in AudioContext.prototype) {
      document.querySelector(refreshButtonCssSelector).onclick =
          () => this.refreshDevices_();
      this.deviceSelector_ = document.querySelector(deviceSelectorCssSelector);
      this.deviceSelector_.oninput = () => this.updateSelectedDevice_();

      // TODO: Check if I already have device enumeration permission
      // and use refreshDevices_ if so.
      this.updateHtml_();
    } else {
      /** @type {HTMLElement} */
      const div = document.querySelector(containerDivCssSelector);
      div.hidden = true;
    }
  }

  async getOrCreateAudioContext() {
    if (!this.audioCtx_) {
      this.audioCtx_ = new window.AudioContext();
    }
    await this.updateSinkIfContextAvailable_();
    return this.audioCtx_;
  }

  async updateSinkIfContextAvailable_() {
    if (!this.audioCtx_) return;
    if (SinkIds.areSame(this.selectedDevice_, this.audioCtx_.sinkId)) return;

    let sinkId = this.selectedDevice_;
    if (SinkIds.isNone(this.selectedDevice_)) sinkId = {type: 'none'};
    return this.audioCtx_.setSinkId(sinkId);
  }

  async refreshDevices_() {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    console.debug("Found audio devices: ", devices);
    const outputs = devices.filter(
        device => device.kind == "audiooutput" &&
                  !SinkIds.isDefault(device.deviceId));
    console.debug("Found audio Output devices: ", outputs);
    const newDevices = outputs
        .map(dev => ({id: dev.deviceId, label: dev.label}))
        .sort((a, b) => a.label.localeCompare(b));
    this.updateHtml_(newDevices);
  }

  async updateSelectedDevice_() {
    const newSelection = this.deviceSelector_.value;
    if (newSelection == this.selectedDevice_) return;
    this.selectedDevice_ = newSelection;
    await this.updateSinkIfContextAvailable_();
  }

  updateHtml_(newDevices = []) {
    const STANDARD_DEVICES = [
      {id: SinkIds.DEFAULT, label: "Default"},
      {id: SinkIds.NONE, label: "Mute"},
    ];
    const addDevice = (device) => {
      const option = document.createElement("option");
      option.value = device.id;
      option.text = device.label;
      this.deviceSelector_.add(option);

      if (device.id === this.selectedDevice_) {
        this.deviceSelector_.selectedIndex = this.deviceSelector_.length - 1;
      }
    };

    this.deviceSelector_.length = 0;
    STANDARD_DEVICES.forEach(addDevice);
    newDevices.forEach(addDevice);

    if (this.deviceSelector_.value !== this.selectedDevice_) {
      console.warn(
          "The new set of audio output devices is missing the selected " +
          "device before the refresh. Falling back to default device.",
          this.selectedDevice_, newDevices);
      this.selectedDevice_ = SinkIds.DEFAULT;
      this.deviceSelector_.selectedIndex = 0;
      this.updateSinkIfContextAvailable_();
    }
  }
};

// Controllers are globals so that it's easier to debug them with dev tools.
const audioOutputDeviceSelectController =
    new AudioOutputDeviceSelectController();
const destinationNodeFactory = async () => {
  const ctx = await audioOutputDeviceSelectController.getOrCreateAudioContext();
  return ctx.destination;
};

const wakeSignalController = new WakeSignalController(destinationNodeFactory);
const pingCenterController = new PingController(destinationNodeFactory);
const pingLeftController = new PingController(
    destinationNodeFactory,
    {pan: PAN.LEFT, freqs: CHORD_A_MIN});
const pingRightController = new PingController(
    destinationNodeFactory,
    {pan: PAN.RIGHT, freqs: CHORD_A_MAJ});

function onBodyLoad() {
  audioOutputDeviceSelectController.mountTo(
      "#audioDeviceSelectionContainer", "#queryAudioDevices",
      "#audioOutputDeviceSelection");

  wakeSignalController.mountTo("#playPause", "#currentSound");
  pingCenterController.mountTo("#pingCenter");
  pingLeftController.mountTo("#pingLeft");
  pingRightController.mountTo("#pingRight");
}