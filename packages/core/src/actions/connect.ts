import type {
  Address,
  ResourceUnavailableRpcErrorType,
  UserRejectedRequestErrorType,
} from 'viem'

import type { CreateConnectorFn } from '../connectors/createConnector.js'
import type { Config, Connector } from '../createConfig.js'
import type { BaseErrorType, ErrorType } from '../errors/base.js'
import {
  ConnectorAlreadyConnectedError,
  type ConnectorAlreadyConnectedErrorType,
} from '../errors/config.js'
import type { ChainIdParameter } from '../types/properties.js'
import type { Compute } from '../types/utils.js'

export type ConnectParameters<
  config extends Config = Config,
  connector extends Connector | CreateConnectorFn =
    | Connector
    | CreateConnectorFn,
  ///
  parameters extends unknown | undefined =
    | (connector extends CreateConnectorFn
        ? Omit<
            NonNullable<Parameters<ReturnType<connector>['connect']>[0]>,
            'isReconnecting'
          >
        : never)
    | (connector extends Connector
        ? Omit<
            NonNullable<Parameters<connector['connect']>[0]>,
            'isReconnecting'
          >
        : never),
> = Compute<
  ChainIdParameter<config> & {
    connector: connector | CreateConnectorFn
  }
> &
  parameters

export type ConnectReturnType<config extends Config = Config> = {
  accounts: readonly [Address, ...Address[]]
  chainId:
    | config['chains'][number]['id']
    | (number extends config['chains'][number]['id'] ? number : number & {})
}

export type ConnectErrorType =
  | ConnectorAlreadyConnectedErrorType
  // connector.connect()
  | UserRejectedRequestErrorType
  | ResourceUnavailableRpcErrorType
  // base
  | BaseErrorType
  | ErrorType

/** https://wagmi.sh/core/api/actions/connect */
export async function connect<
  config extends Config,
  connector extends Connector | CreateConnectorFn,
>(
  config: config,
  parameters: ConnectParameters<config, connector>,
): Promise<ConnectReturnType<config>> {
  // "Register" connector if not already created
  let connector: Connector
  if (typeof parameters.connector === 'function') {
    connector = config._internal.connectors.setup(parameters.connector)
  } else connector = parameters.connector

  // Check if connector is already connected
  if (connector.uid === config.state.current)
    throw new ConnectorAlreadyConnectedError()

  try {
    config.setState((x) => ({ ...x, status: 'connecting' }))
    connector.emitter.emit('message', { type: 'connecting' })

    const { connector: _, ...rest } = parameters

    const [connectedAccounts, connectedChainId] = await Promise.all([
      connector.getAccounts().catch(() => undefined),
      connector.getChainId().catch(() => undefined),
    ])

    // If the connector is already connected override the existing connection
    if (
      connectedAccounts &&
      connectedAccounts.length > 0 &&
      typeof connectedChainId === 'number'
    ) {
      config.setState((x) => ({
        ...x,
        connections: new Map(x.connections).set(connector.uid, {
          accounts: connectedAccounts as readonly [Address, ...Address[]],
          chainId: connectedChainId,
          connector,
        }),
        current: connector.uid,
        status: 'connected',
      }))

      return {
        accounts: connectedAccounts as readonly [Address, ...Address[]],
        chainId: connectedChainId,
      }
    }

    const data = await connector.connect(rest)
    const accounts = data.accounts as readonly [Address, ...Address[]]

    connector.emitter.off('connect', config._internal.events.connect)
    connector.emitter.on('change', config._internal.events.change)
    connector.emitter.on('disconnect', config._internal.events.disconnect)

    await config.storage?.setItem('recentConnectorId', connector.id)
    config.setState((x) => ({
      ...x,
      connections: new Map(x.connections).set(connector.uid, {
        accounts,
        chainId: data.chainId,
        connector: connector,
      }),
      current: connector.uid,
      status: 'connected',
    }))

    return { accounts, chainId: data.chainId }
  } catch (error) {
    config.setState((x) => ({
      ...x,
      // Keep existing connector connected in case of error
      status: x.current ? 'connected' : 'disconnected',
    }))
    throw error
  }
}
