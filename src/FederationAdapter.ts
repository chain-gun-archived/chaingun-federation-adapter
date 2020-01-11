import { diffGunCRDT, mergeGraph } from '@chaingun/crdt'
import {
  GunGetOpts,
  GunGraphAdapter,
  GunGraphData,
  GunNode
} from '@chaingun/types'
import uuid from 'uuid'

type PeerSet = Record<string, GunGraphAdapter>

export interface FederatedAdapterOpts {
  readonly backSync?: number
  readonly maxStaleness?: number
  readonly maintainChangelog?: boolean
  readonly putToPeers?: boolean
}

const CHANGELOG_SOUL = 'changelog'
const PEER_SYNC_SOUL = `peersync`

const DEFAULTS = {
  backSync: 1000 * 60 * 60 * 24, // 1 day
  maintainChangelog: true,
  maxStaleness: 1000 * 60 * 60 * 24,
  putToPeers: false
}

const NOOP = () => {
  // intentionally left blank
}

const getOtherPeers = (allPeers: PeerSet, peerName: string): PeerSet => {
  const otherPeers: PeerSet = Object.keys(allPeers).reduce((res, key) => {
    if (key === peerName) {
      return res
    }
    return {
      ...res,
      [key]: allPeers[key]
    }
  }, {})
  return otherPeers
}

async function updateChangelog(
  internal: GunGraphAdapter,
  diff: GunGraphData
): Promise<void> {
  const now = new Date()
  const itemKey = `${now.toISOString()}-${uuid.v4()}`

  await internal.put({
    [CHANGELOG_SOUL]: {
      _: {
        '#': CHANGELOG_SOUL,
        '>': {
          [itemKey]: now.getTime()
        }
      },
      [itemKey]: diff
    }
  })
}

async function updateFromPeer(
  internal: GunGraphAdapter,
  persist: GunGraphAdapter,
  peerName: string,
  allPeers: PeerSet,
  soul: string,
  adapterOpts?: FederatedAdapterOpts
): Promise<void> {
  if (soul === CHANGELOG_SOUL || soul === PEER_SYNC_SOUL) {
    return
  }

  const peer = allPeers[peerName]
  const otherPeers = getOtherPeers(allPeers, peerName)
  const {
    maxStaleness = DEFAULTS.maxStaleness,
    maintainChangelog = DEFAULTS.maintainChangelog,
    putToPeers = DEFAULTS.putToPeers
  } = adapterOpts || DEFAULTS
  const peerSoul = `peers/${peerName}`
  const now = new Date().getTime()
  const status = await internal.get(peerSoul, {
    '.': soul
  })
  const staleness = now - ((status && status._['>'][soul]) || 0)

  if (staleness < maxStaleness) {
    return
  }

  const node = await peer.get(soul)

  if (node) {
    try {
      const diff = await persist.put({
        [soul]: node
      })

      if (diff) {
        if (maintainChangelog) {
          updateChangelog(internal, diff)
        }

        if (putToPeers) {
          updatePeers(diff, otherPeers)
        }
      }
    } catch (e) {
      // tslint:disable-next-line: no-console
      console.warn('Error updating from peer', {
        error: e.stack,
        peerName,
        soul
      })
    }
  }

  await internal.put({
    [peerSoul]: {
      _: {
        '#': peerSoul,
        '>': {
          [soul]: now
        }
      },
      [soul]: node ? true : false
    }
  })
}

function updateFromPeers(
  internal: GunGraphAdapter,
  persist: GunGraphAdapter,
  allPeers: PeerSet,
  soul: string,
  opts?: FederatedAdapterOpts
): Promise<void> {
  const peerNames = Object.keys(allPeers)
  return peerNames.length
    ? Promise.all(
        peerNames.map(name =>
          updateFromPeer(internal, persist, name, allPeers, soul, opts)
        )
      ).then(NOOP)
    : Promise.resolve()
}

function updatePeers(data: GunGraphData, otherPeers: PeerSet): Promise<void> {
  const entries = Object.entries(otherPeers)
  return entries.length
    ? Promise.all(
        entries.map(([name, peer]) =>
          peer.put(data).catch(err => {
            // @ts-ignore
            // tslint:disable-next-line: no-console
            console.warn('Failed to update peer', name, err.stack || err, data)
          })
        )
      ).then(NOOP)
    : Promise.resolve()
}

type ChangeSetEntry = readonly [string, GunGraphData]

export function getChangesetFeed(
  peer: GunGraphAdapter,
  from: string
): () => Promise<ChangeSetEntry | null> {
  // tslint:disable-next-line: no-let
  let lastKey = from
  // tslint:disable-next-line: readonly-array
  const changes: ChangeSetEntry[] = []
  // tslint:disable-next-line: no-let
  let nodePromise: Promise<GunNode | null> | null = null

  return async function getNext(): Promise<
    readonly [string, GunGraphData] | null
  > {
    if (!changes.length && !nodePromise) {
      nodePromise = peer.get(CHANGELOG_SOUL, {
        '>': `${lastKey}一`
      })
      const node = await nodePromise

      if (node) {
        for (const key in node) {
          if (key && key !== '_') {
            changes.splice(0, 0, [key, node[key]])
            lastKey = key
          }
        }
      }
    } else if (nodePromise) {
      await nodePromise
    }

    const entry = changes.pop()
    return entry || null
  }
}

export async function syncWithPeer(
  internal: GunGraphAdapter,
  persist: GunGraphAdapter,
  peerName: string,
  allPeers: PeerSet,
  from: string,
  adapterOpts: FederatedAdapterOpts = DEFAULTS
): Promise<string> {
  const {
    maintainChangelog = DEFAULTS.maintainChangelog,
    putToPeers = DEFAULTS.putToPeers
  } = adapterOpts || DEFAULTS

  const peer = allPeers[peerName]
  const otherPeers = getOtherPeers(allPeers, peerName)
  const getNext = getChangesetFeed(peer, from)
  // tslint:disable-next-line: no-let
  // tslint:disable-next-line: no-let
  let entry: ChangeSetEntry | null

  // tslint:disable-next-line: no-let
  let batchCount = 0
  const batchSize = 1000
  // tslint:disable-next-line: no-let
  let batchedChanges: GunGraphData = {}

  async function writeBatch(key: string): Promise<void> {
    try {
      console.log('sync batch', peerName, batchCount, key)
      const diff = await persist.put(batchedChanges)

      if (diff) {
        if (maintainChangelog) {
          updateChangelog(internal, diff)
        }

        if (putToPeers) {
          updatePeers(diff, otherPeers)
        }
      }
    } catch (e) {
      // tslint:disable-next-line: no-console
      console.warn('Error syncing from peer', peerName, e.stack)
    }

    batchedChanges = {}
    batchCount = 0
  }

  // tslint:disable-next-line: no-let
  let lastSeenKey: string = from

  // tslint:disable-next-line: no-conditional-assignment
  while ((entry = await getNext())) {
    const [key, changes] = entry
    const diff = diffGunCRDT(changes, batchedChanges)
    batchedChanges = diff
      ? mergeGraph(batchedChanges, diff, 'mutable')
      : batchedChanges
    batchCount++

    if (batchCount >= batchSize) {
      await writeBatch(key)
    }

    if (key > lastSeenKey) {
      lastSeenKey = key
    }
  }

  if (lastSeenKey && Object.keys(batchedChanges).length) {
    await writeBatch(lastSeenKey)
  }

  if (lastSeenKey > from) {
    console.log('updated to', peerName, from)
    await internal.put({
      [PEER_SYNC_SOUL]: {
        _: {
          '#': PEER_SYNC_SOUL,
          '>': {
            [peerName]: new Date().getTime()
          }
        },
        [peerName]: lastSeenKey
      }
    })
  }

  return lastSeenKey
}

export async function syncWithPeers(
  internal: GunGraphAdapter,
  persist: GunGraphAdapter,
  allPeers: PeerSet,
  adapterOpts: FederatedAdapterOpts = DEFAULTS
): Promise<void> {
  const { backSync = DEFAULTS.backSync } = adapterOpts || DEFAULTS
  const peerNames = Object.keys(allPeers)
  const yesterday = new Date(Date.now() - backSync).toISOString()
  return peerNames.length
    ? Promise.all(
        peerNames.map(async peerName => {
          const node = await internal.get(PEER_SYNC_SOUL, { '.': peerName })
          const key = (node && node[peerName]) || yesterday

          return syncWithPeer(
            internal,
            persist,
            peerName,
            allPeers,
            key,
            adapterOpts
          )
        })
      ).then(NOOP)
    : Promise.resolve()
}

export interface FederatedGunGraphAdapter extends GunGraphAdapter {
  readonly syncWithPeers: () => Promise<void>
  readonly getChangesetFeed: (
    from: string
  ) => () => Promise<ChangeSetEntry | null>
}

export function createFederatedAdapter(
  internal: GunGraphAdapter,
  external: PeerSet,
  persistence?: GunGraphAdapter,
  adapterOpts: FederatedAdapterOpts = DEFAULTS
): FederatedGunGraphAdapter {
  const {
    putToPeers = DEFAULTS.putToPeers,
    maintainChangelog = DEFAULTS.maintainChangelog
  } = adapterOpts
  const persist = persistence || internal
  const peers = { ...external }

  return {
    get: async (soul: string, opts?: GunGetOpts) => {
      await updateFromPeers(internal, persist, peers, soul, adapterOpts)
      return internal.get(soul, opts)
    },

    getJsonString: internal.getJsonString
      ? async (soul: string, opts?: GunGetOpts) => {
          await updateFromPeers(internal, persist, peers, soul, adapterOpts)
          return internal.getJsonString!(soul, opts)
        }
      : undefined,

    put: async (data: GunGraphData) => {
      const diff = await persist.put(data)

      if (!diff) {
        return diff
      }

      if (maintainChangelog) {
        updateChangelog(internal, diff)
      }

      if (putToPeers) {
        updatePeers(diff, peers)
      }

      return diff
    },

    syncWithPeers: () =>
      syncWithPeers(internal, persist, external, adapterOpts),

    getChangesetFeed: (from: string) => getChangesetFeed(internal, from)
  }
}

export const FederationAdapter = {
  create: createFederatedAdapter
}
