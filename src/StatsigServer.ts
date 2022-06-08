import DynamicConfig from './DynamicConfig';
import Evaluator from './Evaluator';
import Layer from './Layer';
import LogEvent from './LogEvent';
import { StatsigOptionsType } from './StatsigOptionsType';
import { StatsigUser } from './StatsigUser';
import LogEventProcessor from './LogEventProcessor';
import StatsigOptions from './StatsigOptions';
import StatsigFetcher from './utils/StatsigFetcher';
import ConfigEvaluation from './ConfigEvaluation';

const { getStatsigMetadata, isUserIdentifiable } = require('./utils/core');

const MAX_VALUE_SIZE = 64;
const MAX_OBJ_SIZE = 1024;
const MAX_USER_SIZE = 2048;
let hasLoggedNoUserIdWarning = false;

/**
 * The global statsig class for interacting with gates, configs, experiments configured in the statsig developer console.  Also used for event logging to view in the statsig console, or for analyzing experiment impacts using pulse.
 */
export default class StatsigServer {
  private _pendingInitPromise: Promise<void> | null = null;
  private _ready: boolean = false;
  private _options: StatsigOptions;
  private _logger: LogEventProcessor;
  private _secretKey: string;
  private _evaluator: Evaluator;
  private _fetcher: StatsigFetcher;

  public constructor(secretKey: string, options: StatsigOptionsType = {}) {
    this._secretKey = secretKey;
    this._options = new StatsigOptions(options);
    this._pendingInitPromise = null;
    this._ready = false;
    this._fetcher = new StatsigFetcher(this._secretKey, this._options);
    this._evaluator = new Evaluator(this._fetcher, this._options);
    this._logger = new LogEventProcessor(this._fetcher, this._options);
  }

  /**
   * Initializes the statsig server SDK. This must be called before checking gates/configs or logging events.
   * @throws Error if a Server Secret Key is not provided
   */
  public initializeAsync(): Promise<void> {
    if (this._pendingInitPromise != null) {
      return this._pendingInitPromise;
    }

    if (this._ready === true) {
      return Promise.resolve();
    }

    if (
      typeof this._secretKey !== 'string' ||
      this._secretKey.length === 0 ||
      !this._secretKey.startsWith('secret-')
    ) {
      return Promise.reject(
        new Error(
          'Invalid key provided.  You must use a Server Secret Key from the Statsig console with the node-js-server-sdk',
        ),
      );
    }

    const initPromise = this._evaluator.init().finally(() => {
      this._ready = true;
      this._pendingInitPromise = null;
    });
    if (
      this._options.initTimeoutMs != null &&
      this._options.initTimeoutMs > 0
    ) {
      this._pendingInitPromise = Promise.race([
        initPromise,
        new Promise((resolve) => {
          setTimeout(() => {
            this._ready = true;
            this._pendingInitPromise = null;
            resolve();
          }, this._options.initTimeoutMs);
        }) as Promise<void>,
      ]);
    } else {
      this._pendingInitPromise = initPromise;
    }

    return this._pendingInitPromise;
  }

  /**
   * Check the value of a gate configured in the statsig console
   * @throws Error if initialize() was not called first
   * @throws Error if the gateName is not provided or not a non-empty string
   */
  public checkGate(user: StatsigUser, gateName: string): Promise<boolean> {
    const { rejection, normalizedUser } = this._validateInputs(
      user,
      gateName,
      'gateName',
    );

    return (
      rejection ??
      this._getGateValue(normalizedUser, gateName).then((gate) => {
        return gate?.value === true ?? false;
      })
    );
  }

  /**
   * Checks the value of a config for a given user
   * @throws Error if initialize() was not called first
   * @throws Error if the configName is not provided or not a non-empty string
   */
  public getConfig(
    user: StatsigUser,
    configName: string,
  ): Promise<DynamicConfig> {
    const { rejection, normalizedUser } = this._validateInputs(
      user,
      configName,
      'configName',
    );

    return rejection ?? this._getConfigValue(normalizedUser, configName);
  }

  /**
   * Checks the value of a config for a given user
   * @throws Error if initialize() was not called first
   * @throws Error if the experimentName is not provided or not a non-empty string
   */
  public getExperiment(
    user: StatsigUser,
    experimentName: string,
  ): Promise<DynamicConfig> {
    const { rejection, normalizedUser } = this._validateInputs(
      user,
      experimentName,
      'experimentName',
    );

    return rejection ?? this._getConfigValue(normalizedUser, experimentName);
  }

  /**
   * Checks the value of a config for a given user
   * @throws Error if initialize() was not called first
   * @throws Error if the layerName is not provided or not a non-empty string
   */
  public getLayer(user: StatsigUser, layerName: string): Promise<Layer> {
    const { rejection, normalizedUser } = this._validateInputs(
      user,
      layerName,
      'layerName',
    );

    return rejection ?? this._getLayerValue(normalizedUser, layerName);
  }

  /**
   * Log an event for data analysis and alerting or to measure the impact of an experiment
   * @throws Error if initialize() was not called first
   */
  public logEvent(
    user: StatsigUser,
    eventName: string,
    value: string | number | null = null,
    metadata: Record<string, unknown> | null = null,
  ) {
    this.logEventObject({
      eventName: eventName,
      user: user,
      value: value,
      metadata: metadata,
    });
  }

  public logEventObject(eventObject: {
    eventName: string;
    user: StatsigUser;
    value?: string | number | null;
    metadata?: Record<string, unknown> | null;
    time?: string | null;
  }) {
    let eventName = eventObject.eventName;
    let user = eventObject.user ?? null;
    let value = eventObject.value ?? null;
    let metadata = eventObject.metadata ?? null;
    let time = eventObject.time ?? null;

    if (!(this._ready === true && this._logger != null)) {
      throw new Error('Must call initialize() first.');
    }
    if (typeof eventName !== 'string' || eventName.length === 0) {
      console.error(
        'statsigSDK::logEvent> Must provide a valid string for the eventName.',
      );
      return;
    }
    if (!isUserIdentifiable(user) && !hasLoggedNoUserIdWarning) {
      hasLoggedNoUserIdWarning = true;
      console.warn(
        'statsigSDK::logEvent> No valid userID was provided. Event will be logged but not associated with an identifiable user. This message is only logged once.',
      );
    }
    user = normalizeUser(user, this._options);
    if (shouldTrimParam(eventName, MAX_VALUE_SIZE)) {
      console.warn(
        'statsigSDK::logEvent> eventName is too long, trimming to ' +
          MAX_VALUE_SIZE +
          '.',
      );
      eventName = eventName.substring(0, MAX_VALUE_SIZE);
    }
    if (typeof value === 'string' && shouldTrimParam(value, MAX_VALUE_SIZE)) {
      console.warn(
        'statsigSDK::logEvent> value is too long, trimming to ' +
          MAX_VALUE_SIZE +
          '.',
      );
      value = value.substring(0, MAX_VALUE_SIZE);
    }

    if (shouldTrimParam(metadata, MAX_OBJ_SIZE)) {
      console.warn(
        'statsigSDK::logEvent> metadata is too big. Dropping the metadata.',
      );
      metadata = { error: 'not logged due to size too large' };
    }

    let event = new LogEvent(eventName);
    event.setUser(user);
    event.setValue(value);
    event.setMetadata(metadata);

    if (typeof time === 'number') {
      event.setTime(time);
    }

    this._logger.log(event);
  }

  /**
   * Informs the statsig SDK that the server is closing or shutting down
   * so the SDK can clean up internal state
   */
  public shutdown() {
    if (this._logger == null) {
      return;
    }
    this._ready = false;
    this._logger.shutdown();
    this._fetcher.shutdown();
    this._evaluator.shutdown();
  }

  public async flush(): Promise<void> {
    if (this._logger == null) {
      return Promise.resolve();
    }

    return this._logger.flush();
  }

  public getClientInitializeResponse(user: StatsigUser): Record<string, unknown> | null {
    if (this._ready !== true) {
      throw new Error(
        'statsigSDK::getClientInitializeResponse> Must call initialize() first.',
      );
    }
    const normalizedUser = normalizeUser(user, this._options);
    return this._evaluator.getClientInitializeResponse(normalizedUser);
  }

  public overrideGate(
    gateName: string,
    value: boolean,
    userID: string | null = '',
  ) {
    if (typeof value !== 'boolean') {
      console.warn(
        'statsigSDK> Attempted to override a gate with a non boolean value',
      );
      return;
    }
    this._evaluator.overrideGate(gateName, value, userID);
  }

  public overrideConfig(
    configName: string,
    value: Record<string, unknown>,
    userID: string | null = '',
  ) {
    if (typeof value !== 'object') {
      console.warn(
        'statsigSDK> Attempted to override a config with a non object value',
      );
      return;
    }
    this._evaluator.overrideConfig(configName, value, userID);
  }

  private _validateInputs(user: StatsigUser, name: string, usage: string) {
    const result : {rejection: null | Promise<never>, normalizedUser: StatsigUser} = { rejection: null, normalizedUser: {} };
    if (this._ready !== true) {
      result.rejection = Promise.reject(
        new Error('Must call initialize() first.'),
      );
    } else if (typeof name !== 'string' || name.length === 0) {
      result.rejection = Promise.reject(
        new Error(`Must pass a valid ${usage} to check`),
      );
    } else if (!isUserIdentifiable(user)) {
      result.rejection = Promise.reject(
        new Error(
          'Must pass a valid user with a userID or customID for the server SDK to work. See https://docs.statsig.com/messages/serverRequiredUserID/ for more details.',
        ),
      );
    } else {
      result.normalizedUser = normalizeUser(user, this._options);
    }

    return result;
  }

  private _getGateValue(
    user: StatsigUser,
    gateName: string,
  ): Promise<{ value: boolean }> {
    let ret = this._evaluator.checkGate(user, gateName) ?? {
      value: false,
      rule_id: '',
      secondary_exposures: [],
      config_delegate: undefined,
      fetch_from_server: false,
    };

    if (!ret.fetch_from_server) {
      this._logger.logGateExposure(
        user,
        gateName,
        ret.value,
        ret.rule_id,
        ret.secondary_exposures,
      );
      return Promise.resolve({ value: ret.value });
    }

    return this._fetcher
      .dispatch(
        this._options.api + '/check_gate',
        Object.assign({
          user: user,
          gateName: gateName,
          statsigMetadata: getStatsigMetadata(),
        }),
        5000,
      )
      .then((res) => {
        // @ts-ignore
        return res.json();
      });
  }

  private _getConfigValue(
    user: StatsigUser,
    configName: string,
  ): Promise<DynamicConfig> {
    const ret = this._evaluator.getConfig(user, configName);
    if (!ret?.fetch_from_server) {
      const config = new DynamicConfig(
        configName,
        ret?.json_value as Record<string, unknown>,
        ret?.rule_id,
        ret?.secondary_exposures,
      );

      this._logger.logConfigExposure(
        user,
        configName,
        config.getRuleID(),
        config._getSecondaryExposures(),
      );

      return Promise.resolve(config);
    }

    return this._fetchConfig(user, configName);
  }

  private _getLayerValue(user: StatsigUser, layerName: string): Promise<Layer> {
    let ret = this._evaluator.getLayer(user, layerName);
    if (ret != null && !ret.fetch_from_server) {
      const logFunc = (
        layer: Layer,
        parameterName: string,
      ) => {
        if (this._logger == null) {
          return;
        }
        this._logger.logLayerExposure(user, layer, parameterName, ret as ConfigEvaluation);
      };
      const layer = new Layer(
        layerName,
        ret?.json_value as Record<string, unknown>,
        ret?.rule_id,
        logFunc,
      );

      return Promise.resolve(layer);
    }

    if (ret?.config_delegate) {
      return this._fetchConfig(user, ret.config_delegate)
        .then((config) => {
          return Promise.resolve(
            new Layer(layerName, config?.value, config?.getRuleID()),
          );
        })
        .catch(() => {
          return Promise.resolve(new Layer(layerName));
        });
    }

    return Promise.resolve(new Layer(layerName));
  }

  private _fetchConfig(
    user: StatsigUser,
    name: string,
  ): Promise<DynamicConfig> {
    return this._fetcher
      .dispatch(
        this._options.api + '/get_config',
        {
          user: user,
          configName: name,
          statsigMetadata: getStatsigMetadata(),
        },
        5000,
      )
      .then((res) => {
        // @ts-ignore
        return res.json();
      })
      .then((resJSON) => {
        return Promise.resolve(
          new DynamicConfig(name, resJSON.value, resJSON.rule_id),
        );
      })
      .catch(() => {
        return Promise.resolve(new DynamicConfig(name));
      });
  }
}

function shouldTrimParam(
  param: object | string | number | null | unknown,
  size: number,
): boolean {
  if (param == null) return false;
  if (typeof param === 'string') return param.length > size;
  if (typeof param === 'object') {
    return JSON.stringify(param).length > size;
  }
  if (typeof param === 'number') return param.toString().length > size;
  return false;
}

function normalizeUser(
  user: StatsigUser,
  options: StatsigOptions,
): StatsigUser {
  user = trimUserObjIfNeeded(user);
  if (options?.environment != null) {
    user['statsigEnvironment'] = options?.environment;
  }
  return user;
}

function trimUserObjIfNeeded(user: StatsigUser | null): StatsigUser {
  if (user == null) return {};
  if (user.userID != null && shouldTrimParam(user.userID, MAX_VALUE_SIZE)) {
    console.warn(
      'statsigSDK> User ID is too large, trimming to ' + MAX_VALUE_SIZE,
    );
    user.userID = user.userID.toString().substring(0, MAX_VALUE_SIZE);
  }
  if (shouldTrimParam(user, MAX_USER_SIZE)) {
    user.custom = {};
    if (shouldTrimParam(user, MAX_USER_SIZE)) {
      console.warn(
        'statsigSDK> User object is too large, only keeping the user ID.',
      );
      user = { userID: user.userID };
    } else {
      console.warn(
        'statsigSDK> User object is too large, dropping the custom property.',
      );
    }
  }
  return user;
}
