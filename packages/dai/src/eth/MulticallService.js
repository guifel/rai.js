import { PublicService } from '@makerdao/services-core';
import { createWatcher } from '@makerdao/multicall';
import debug from 'debug';
import { ReplaySubject } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import merge from 'lodash/merge';
import get from 'lodash/get';

const log = debug('dai:MulticallService');

export default class MulticallService extends PublicService {
  constructor(name = 'multicall') {
    super(name, ['web3', 'smartContract']);

    this._rootObservable = new ReplaySubject();
    this._rootSubscription = null;

    this.observableStore = {};
  }

  createWatcher({
    useWeb3Provider = false,
    interval = 'block',
    ...config
  } = {}) {
    const web3 = this.get('web3');
    config = {
      multicallAddress: this.get('smartContract').getContractAddress(
        'MULTICALL'
      ),
      ...config
    };

    let onNewBlockPolling;
    if (interval === 'block') {
      onNewBlockPolling = true;
      config.interval = 60000; // 1 min polling fallback safeguard
    }
    if (useWeb3Provider) config.web3 = web3._web3;
    else {
      if (!web3.rpcUrl) throw new Error('Unable to get rpcUrl for multicall');
      config.rpcUrl = web3.rpcUrl;
    }

    this._watcher = createWatcher([], config);

    if (onNewBlockPolling) {
      log(
        `Watcher created with poll on new block mode using ${
          config.rpcUrl ? `rpcUrl: ${config.rpcUrl}` : 'web3 provider'
        }`
      );
      web3.onNewBlock(blockNumber => {
        log(`Polling after new block detected (${blockNumber})`);
        this._watcher.poll();
      });
    } else {
      log(
        `Watcher created with ${
          config.interval ? config.interval + 'ms' : 'default'
        } polling interval using ${
          config.rpcUrl ? `rpcUrl: ${config.rpcUrl}` : 'web3 provider'
        }`
      );
    }

    this._watcher.onPoll(({ id, latestBlockNumber }) =>
      log(
        `Sending eth_call network request #${id}${
          latestBlockNumber ? ` (latestBlockNumber: ${latestBlockNumber})` : ''
        }`
      )
    );
    this._watcher.onNewBlock(blockHeight =>
      log(`Latest block: ${blockHeight}`)
    );

    return this._watcher;
  }

  tap(cb) {
    log('Watcher tapped');
    return this._watcher.tap(cb);
  }

  start() {
    log('Watcher started');
    return this._watcher.start();
  }

  startObservable() {
    if (this._watcher === undefined) throw new Error('watcher is not defined');

    if (this._rootSubscription === null) {
      log('Initialising multicall data flow through root observable');
      this._rootSubcription = this._watcher.subscribe(updates => {
        this._rootObservable.next(updates);
      });
    }
    return this._rootObservable;
  }

  getObservable(pathString) {
    return get(this.observableStore, pathString);
  }

  destructureContractCall(call) {
    const [callFnName, callTypes, returnTypes] = call
      .split('(')
      .map(s => {
        if (s[s.length - 1] === ')') return s.substring(0, s.length - 1);
        else return s;
      })
      .map(s => s.split(','))
      .map(s => {
        if (Array.isArray(s)) return s.filter(x => x !== '');
        else return s;
      });

    if (returnTypes.length < 1)
      throw new Error(
        'Invalid contract call specified, call must return at least one argument'
      );

    return { callFnName, callTypes, returnTypes };
  }

  registerLogicalSchema(schemas) {
    let addresses = this.get('smartContract').getContractAddresses();
    addresses.MDAI = addresses.MCD_DAI;
    addresses.MWETH = addresses.ETH;

    this._watcher.tap(calls => [
      ...calls,
      ...schemas.reduce(
        (
          acc,
          {
            contractName,
            contractCall,
            callArgs,
            callArgsOverrides,
            returnKeys,
            observableKeys
          }
        ) => {
          const {
            callFnName,
            callTypes,
            returnTypes
          } = this.destructureContractCall(contractCall);

          if (callTypes.length !== callArgs.length)
            throw new Error(
              `Invalid contract call specified, number of call types, ${callTypes} does not match number of call arguments, ${callArgs}`
            );

          if (returnTypes.length !== returnKeys.length)
            throw new Error(
              `Invalid contract call specified, number of return types, ${returnTypes} does not match number of return arguments, ${returnKeys}`
            );

          const callArgsIdentifiers = callArgsOverrides
            ? callArgsOverrides.join('.')
            : callArgs.map(a => a[0]).join('.');

          const callKeyStructure = `${contractName}.${callFnName}.${callArgsIdentifiers}`;

          const processedCallArgs = callArgs.map(([arg, cb]) => {
            if (cb === undefined) return arg;
            return cb(arg);
          });

          const processedReturnKeys = returnKeys.map(([k, cb]) =>
            [`${callKeyStructure}.${k}`, cb].filter(x => x)
          );

          observableKeys.forEach((item, idx) => {
            const filteredObservable = this._rootObservable.pipe(
              filter(({ type }) => type === processedReturnKeys[idx][0]),
              map(({ value }) => value)
            );

            const entry = item.reduceRight(
              (obj, elem) => ({ [elem]: obj }),
              filteredObservable
            );

            log(`new observable for call: ${processedReturnKeys[idx][0]}`);

            this.observableStore = merge({}, this.observableStore, entry);
          });

          return [
            ...acc,
            {
              target: addresses[contractName],
              call: [contractCall, ...processedCallArgs],
              returns: [...processedReturnKeys]
            }
          ];
        },
        []
      )
    ]);
    return this.observableStore;
  }

  registerDerivedSchema(schemas) {
    schemas.forEach(({ observableKeys, dependencies, fn }) => {
      const dependentObservables = dependencies.map(d =>
        this.getObservable(d.join('.'))
      );

      const allDependentObservablesExist = !dependentObservables.some(
        x => !!x === false
      );
      if (allDependentObservablesExist) {
        this.observableStore = merge(
          {},
          this.observableStore,
          observableKeys.reduceRight(
            (obj, elem) => ({ [elem]: obj }),
            fn(dependentObservables)
          )
        );
      }
    });
  }

  disconnect() {
    // TODO
  }

  get watcher() {
    return this._watcher;
  }
}
