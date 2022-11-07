import autoBind from "auto-bind";

import { version } from "../package.json";
import { ExtensionManager, ExtensionManagerDependencies } from "./ExtensionManager";
import { JsPsychData, JsPsychDataDependencies } from "./modules/data";
import { PluginAPI, createJointPluginAPIObject } from "./modules/plugin-api";
import * as randomization from "./modules/randomization";
import * as turk from "./modules/turk";
import * as utils from "./modules/utils";
import { ProgressBar } from "./ProgressBar";
import {
  SimulationMode,
  SimulationOptionsParameter,
  TimelineArray,
  TimelineDescription,
  TimelineNodeDependencies,
  TimelineVariable,
  TrialResult,
} from "./timeline";
import { Timeline } from "./timeline/Timeline";
import { Trial } from "./timeline/Trial";
import { PromiseWrapper } from "./timeline/util";

export class JsPsych {
  turk = turk;
  randomization = randomization;
  utils = utils;
  data: JsPsychData;
  pluginAPI: PluginAPI;

  version() {
    return version;
  }

  //
  // private variables
  //

  /**
   * options
   */
  private options: any = {};

  /**
   * experiment timeline
   */
  private timeline?: Timeline;

  // target DOM element
  private domContainer: HTMLElement;
  private domTarget: HTMLElement;

  /**
   * time that the experiment began
   */
  private experimentStartTime: Date;

  /**
   * is the page retrieved directly via file:// protocol (true) or hosted on a server (false)?
   */
  private file_protocol = false;

  /**
   * The simulation mode if the experiment is being simulated
   */
  private simulationMode?: SimulationMode;

  /**
   * Simulation options passed in via `simulate()`
   */
  private simulationOptions: Record<string, SimulationOptionsParameter>;

  private extensionManager: ExtensionManager;

  constructor(options?) {
    // override default options if user specifies an option
    options = {
      display_element: undefined,
      on_finish: () => {},
      on_trial_start: () => {},
      on_trial_finish: () => {},
      on_data_update: () => {},
      on_interaction_data_update: () => {},
      on_close: () => {},
      use_webaudio: true,
      exclusions: {},
      show_progress_bar: false,
      message_progress_bar: "Completion Progress",
      auto_update_progress_bar: true,
      default_iti: 0,
      minimum_valid_rt: 0,
      experiment_width: null,
      override_safe_mode: false,
      case_sensitive_responses: false,
      extensions: [],
      ...options,
    };
    this.options = options;

    autoBind(this); // so we can pass JsPsych methods as callbacks and `this` remains the JsPsych instance

    // detect whether page is running in browser as a local file, and if so, disable web audio and video preloading to prevent CORS issues
    if (
      window.location.protocol == "file:" &&
      (options.override_safe_mode === false || typeof options.override_safe_mode === "undefined")
    ) {
      options.use_webaudio = false;
      this.file_protocol = true;
      console.warn(
        "jsPsych detected that it is running via the file:// protocol and not on a web server. " +
          "To prevent issues with cross-origin requests, Web Audio and video preloading have been disabled. " +
          "If you would like to override this setting, you can set 'override_safe_mode' to 'true' in initJsPsych. " +
          "For more information, see: https://www.jspsych.org/overview/running-experiments"
      );
    }

    // initialize modules
    this.data = new JsPsychData(this.dataDependencies);
    this.pluginAPI = createJointPluginAPIObject(this);

    this.extensionManager = new ExtensionManager(
      this.extensionManagerDependencies,
      options.extensions
    );
  }

  private endMessage?: string;

  /**
   * Starts an experiment using the provided timeline and returns a promise that is resolved when
   * the experiment is finished.
   *
   * @param timeline The timeline to be run
   */
  async run(timeline: TimelineDescription | TimelineArray) {
    if (typeof timeline === "undefined") {
      console.error("No timeline declared in jsPsych.run. Cannot start experiment.");
    }

    if (timeline.length === 0) {
      console.error(
        "No trials have been added to the timeline (the timeline is an empty array). Cannot start experiment."
      );
    }

    // create experiment timeline
    this.timeline = new Timeline(this.timelineDependencies, timeline);

    await this.prepareDom();
    await this.extensionManager.initializeExtensions();

    document.documentElement.setAttribute("jspsych", "present");

    this.experimentStartTime = new Date();

    await this.timeline.run();
    await Promise.resolve(this.options.on_finish(this.data.get()));

    if (this.endMessage) {
      this.getDisplayElement().innerHTML = this.endMessage;
    }
  }

  async simulate(
    timeline: any[],
    simulation_mode: "data-only" | "visual" = "data-only",
    simulation_options = {}
  ) {
    this.simulationMode = simulation_mode;
    this.simulationOptions = simulation_options;
    await this.run(timeline);
  }

  public progressBar?: ProgressBar;

  getProgress() {
    return {
      total_trials: this.timeline?.getNaiveTrialCount(),
      current_trial_global: 0, // TODO This used to be `this.global_trial_index` – is a global trial index still needed / does it make sense and, if so, how should it be maintained?
      percent_complete: this.timeline?.getNaiveProgress() * 100,
    };
  }

  getStartTime() {
    return this.experimentStartTime; // TODO This seems inconsistent, given that `getTotalTime()` returns a number, not a `Date`
  }

  getTotalTime() {
    if (!this.experimentStartTime) {
      return 0;
    }
    return new Date().getTime() - this.experimentStartTime.getTime();
  }

  getDisplayElement() {
    return this.domTarget;
  }

  getDisplayContainerElement() {
    return this.domContainer;
  }

  // TODO Should this be called `abortExperiment()`?
  endExperiment(endMessage?: string, data = {}) {
    this.endMessage = endMessage;
    this.timeline.abort();
    this.pluginAPI.cancelAllKeyboardResponses();
    this.pluginAPI.clearAllTimeouts();
    this.finishTrial(data);
  }

  // TODO Is there a legit use case for this "global" function that cannot be achieved with callback functions in trial/timeline descriptions?
  endCurrentTimeline() {
    // this.timeline.endActiveNode();
  }

  getCurrentTrial() {
    const activeNode = this.timeline?.getLatestNode();
    if (activeNode instanceof Trial) {
      return activeNode.description;
    }
    return undefined;
  }

  getInitSettings() {
    return this.options;
  }

  timelineVariable(variableName: string) {
    return new TimelineVariable(variableName);
  }

  evaluateTimelineVariable(variableName: string) {
    return this.timeline
      ?.getLatestNode()
      ?.evaluateTimelineVariable(new TimelineVariable(variableName));
  }

  pauseExperiment() {
    this.timeline?.pause();
  }

  resumeExperiment() {
    this.timeline?.resume();
  }

  private loadFail(message) {
    message = message || "<p>The experiment failed to load.</p>";
    this.domTarget.innerHTML = message;
  }

  getSafeModeStatus() {
    return this.file_protocol;
  }

  getTimeline() {
    return this.timeline?.description;
  }

  get extensions() {
    return this.extensionManager?.extensions ?? {};
  }

  private async prepareDom() {
    // Wait until the document is ready
    if (document.readyState !== "complete") {
      await new Promise((resolve) => {
        window.addEventListener("load", resolve);
      });
    }

    const options = this.options;

    // set DOM element where jsPsych will render content
    // if undefined, then jsPsych will use the <body> tag and the entire page
    if (typeof options.display_element === "undefined") {
      // check if there is a body element on the page
      const body = document.querySelector("body");
      if (body === null) {
        document.documentElement.appendChild(document.createElement("body"));
      }
      // using the full page, so we need the HTML element to
      // have 100% height, and body to be full width and height with
      // no margin
      document.querySelector("html").style.height = "100%";
      document.querySelector("body").style.margin = "0px";
      document.querySelector("body").style.height = "100%";
      document.querySelector("body").style.width = "100%";
      options.display_element = document.querySelector("body");
    } else {
      // make sure that the display element exists on the page
      const display =
        options.display_element instanceof Element
          ? options.display_element
          : document.querySelector("#" + options.display_element);
      if (display === null) {
        console.error("The display_element specified in initJsPsych() does not exist in the DOM.");
      } else {
        options.display_element = display;
      }
    }

    options.display_element.innerHTML =
      '<div class="jspsych-content-wrapper"><div id="jspsych-content"></div></div>';
    this.domContainer = options.display_element;
    this.domTarget = document.querySelector("#jspsych-content");

    // set experiment_width if not null
    if (options.experiment_width !== null) {
      this.domTarget.style.width = options.experiment_width + "px";
    }

    // add tabIndex attribute to scope event listeners
    options.display_element.tabIndex = 0;

    // add CSS class to DOM_target
    if (options.display_element.className.indexOf("jspsych-display-element") === -1) {
      options.display_element.className += " jspsych-display-element";
    }
    this.domTarget.className += "jspsych-content";

    // create listeners for user browser interaction
    this.data.createInteractionListeners();

    // add event for closing window
    window.addEventListener("beforeunload", options.on_close);

    if (this.options.show_progress_bar) {
      const progressBarContainer = document.createElement("div");
      progressBarContainer.id = "jspsych-progressbar-container";

      this.progressBar = new ProgressBar(progressBarContainer, this.options.message_progress_bar);

      this.getDisplayContainerElement().insertAdjacentElement("afterbegin", progressBarContainer);
    }
  }

  private finishTrialPromise = new PromiseWrapper<TrialResult | void>();
  finishTrial(data?: TrialResult) {
    this.finishTrialPromise.resolve(data);
  }

  private timelineDependencies: TimelineNodeDependencies = {
    onTrialStart: (trial: Trial) => {
      this.options.on_trial_start(trial.trialObject);

      // apply the focus to the element containing the experiment.
      this.getDisplayContainerElement().focus();
      // reset the scroll on the DOM target
      this.getDisplayElement().scrollTop = 0;
    },

    onTrialResultAvailable: (trial: Trial) => {
      trial.getResult().time_elapsed = this.getTotalTime();
      this.data.write(trial);
    },

    onTrialFinished: (trial: Trial) => {
      const result = trial.getResult();
      this.options.on_trial_finish(result);
      this.options.on_data_update(result);

      if (this.progressBar && this.options.auto_update_progress_bar) {
        this.progressBar.progress = this.timeline.getNaiveProgress();
      }
    },

    runOnStartExtensionCallbacks: (extensionsConfiguration) =>
      this.extensionManager.onStart(extensionsConfiguration),

    runOnLoadExtensionCallbacks: (extensionsConfiguration) =>
      this.extensionManager.onLoad(extensionsConfiguration),

    runOnFinishExtensionCallbacks: (extensionsConfiguration) =>
      this.extensionManager.onFinish(extensionsConfiguration),

    getSimulationMode: () => this.simulationMode,

    getGlobalSimulationOptions: () => this.simulationOptions,

    instantiatePlugin: (pluginClass) => new pluginClass(this),

    getDisplayElement: () => this.getDisplayElement(),

    getDefaultIti: () => this.getInitSettings().default_iti,

    finishTrialPromise: this.finishTrialPromise,
  };

  private extensionManagerDependencies: ExtensionManagerDependencies = {
    instantiateExtension: (extensionClass) => new extensionClass(this),
  };

  private dataDependencies: JsPsychDataDependencies = {
    getProgress: () => ({
      time: this.getTotalTime(),
      trial: this.timeline?.getLatestNode().index ?? 0,
    }),

    onInteractionRecordAdded: (record) => {
      this.options.on_interaction_data_update(record);
    },

    getDisplayElement: () => this.getDisplayElement(),
  };
}