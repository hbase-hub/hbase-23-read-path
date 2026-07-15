/**
 * HBase 读路径全流程 — 步骤生成器
 *
 * 动画展示一次 Get 请求的多级查询链路：
 *   Client Get → RegionServer 接收 → 查 BlockCache(命中即返回)
 *   → 查 MemStore → 查 HFile(先过 Bloom Filter 再读) → 多版本合并 → 返回
 * 重点突出"按序查询 + 短路返回"：BlockCache 命中则不查 MemStore/HFile，
 * Bloom Filter 过滤掉不含该 key 的 HFile。
 */
import type { Step, VisualElement, VariableState } from '../types'

/** 读路径伪代码 */
export const TEMPLATE_CODE = `// HBase 读路径：多级查询 + 短路返回
public Result get(Get get) {
    // 1. 校验版本数与列
    checkVersions(get);
    Key key = buildKey(get.getRow(), get.getFamily(), get.getQualifier());

    // 2. 查 BlockCache（命中即短路返回）
    if (cache.hit(key)) {
        return cache.get(key);
    }

    // 3. 查 MemStore（内存最新版本）
    Cell cell = memStore.get(get.getRow(), family, qualifier);
    if (cell != null) {
        return cell;
    }

    // 4. 查 HFile：先过 Bloom Filter 再读
    for (HFile f : files) {
        if (bloom.mightContain(key)) {
            cell = f.get(key);
            if (cell != null) {
                return cell;     // 命中即返回
            }
        }
    }

    // 5. 多版本合并（MVCC 选最新可见版本）
    return Result.mergeVersions();
}`

// 画布布局常量
const LAYOUT = {
  client: { x: 40, y: 210, w: 130, h: 70, label: 'Client' },
  regionserver: { x: 220, y: 200, w: 170, h: 90, label: 'RegionServer' },
  blockcache: { x: 440, y: 80, w: 150, h: 70, label: 'BlockCache' },
  memstore: { x: 440, y: 200, w: 150, h: 80, label: 'MemStore' },
  bloom: { x: 640, y: 90, w: 140, h: 60, label: 'Bloom Filter' },
  hfile1: { x: 640, y: 200, w: 90, h: 70, label: 'HFile-1' },
  hfile2: { x: 745, y: 200, w: 90, h: 70, label: 'HFile-2' },
  hfile3: { x: 850, y: 200, w: 90, h: 70, label: 'HFile-3' },
}

function makeElements(highlight?: string): VisualElement[] {
  const mk = (
    key: keyof typeof LAYOUT,
    type: string,
    state: string
  ): VisualElement => {
    const l = LAYOUT[key]
    return {
      id: key,
      type,
      label: l.label,
      x: l.x,
      y: l.y,
      width: l.w,
      height: l.h,
      state: key === highlight ? 'active' : state,
    }
  }
  return [
    mk('client', 'client', 'idle'),
    mk('regionserver', 'rs', 'idle'),
    mk('blockcache', 'cache', 'idle'),
    mk('memstore', 'memstore', 'idle'),
    mk('bloom', 'bloom', 'idle'),
    mk('hfile1', 'hfile', 'idle'),
    mk('hfile2', 'hfile', 'idle'),
    mk('hfile3', 'hfile', 'idle'),
  ]
}

export function generateSteps(): Step[] {
  const steps: Step[] = []
  let idx = 0

  const push = (
    desc: string,
    line: number,
    vars: VariableState[],
    elements: VisualElement[],
    arrows: { from: string; to: string; label?: string }[] = [],
    actionLabel?: string,
    statusText?: string
  ) => {
    steps.push({
      index: idx++,
      description: desc,
      currentLine: line,
      variables: vars,
      elements,
      connections: arrows.map((a, i) => ({
        id: `arrow-${i}`,
        fromId: a.from,
        toId: a.to,
        kind: 'arrow' as const,
        label: a.label,
      })),
      annotations: [],
      actionLabel,
      statusText: statusText ?? desc,
    })
  }

  // 步骤 0：读路径总览
  push(
    '读路径：Client Get → BlockCache(命中?) → MemStore → HFile(过 Bloom) → 多版本合并 → 返回',
    0,
    [],
    makeElements(),
    [
      { from: 'client', to: 'regionserver', label: 'Get' },
      { from: 'regionserver', to: 'blockcache', label: '1.查缓存' },
      { from: 'regionserver', to: 'memstore', label: '2.查内存' },
      { from: 'bloom', to: 'hfile1', label: '过滤' },
    ],
    'READ_PATH',
    '读路径总览'
  )

  // 步骤 1：Client Get + 校验
  push(
    'Client 发起 Get，RegionServer 校验版本数与列，构造查询 Key(row+family+qualifier)',
    3,
    [
      { name: 'key', value: 'row1:cf1:q1', line: 4, type: 'Key' },
    ],
    makeElements('client'),
    [{ from: 'client', to: 'regionserver', label: '1.Get' }],
    'GET',
    'Client Get + 校验'
  )

  // 步骤 2：查 BlockCache（未命中）
  push(
    '先查 BlockCache：cache.hit(key) 返回 false，未命中，继续向下查',
    7,
    [
      { name: 'cacheHit', value: 'false', line: 7, type: 'boolean' },
      { name: 'key', value: 'row1:cf1:q1', line: 4, type: 'Key' },
    ],
    makeElements('blockcache').map((e) =>
      e.id === 'blockcache' ? { ...e, state: 'miss' } : e
    ),
    [{ from: 'regionserver', to: 'blockcache', label: '2.cache.hit? miss' }],
    'CACHE_MISS',
    '查 BlockCache (未命中)'
  )

  // 步骤 3：查 MemStore（无数据）
  push(
    '查 MemStore（内存最新版本）：memStore.get() 返回 null，无该 Cell，继续查 HFile',
    12,
    [
      { name: 'memstore', value: 'null (无此 key)', line: 12, type: 'Cell' },
      { name: 'cacheHit', value: 'false', line: 7, type: 'boolean' },
    ],
    makeElements('memstore').map((e) =>
      e.id === 'memstore' ? { ...e, state: 'miss' } : e
    ),
    [{ from: 'regionserver', to: 'memstore', label: '3.memStore.get? null' }],
    'MEMSTORE_MISS',
    '查 MemStore (无数据)'
  )

  // 步骤 4：Bloom Filter 过滤
  push(
    '查 HFile 前先过 Bloom Filter：3 个 HFile 中 HFile-1 可能含 key，HFile-2/3 被过滤',
    16,
    [
      { name: 'bloomCheck', value: '3', line: 16, type: 'int' },
      { name: 'bloom.mightContain', value: 'HFile-1=true', line: 16 },
    ],
    makeElements('bloom').map((e) => {
      if (e.id === 'bloom') return { ...e, state: 'active' }
      if (e.id === 'hfile1') return { ...e, state: 'active' }
      if (e.id === 'hfile2' || e.id === 'hfile3')
        return { ...e, state: 'filtered' }
      return e
    }),
    [{ from: 'bloom', to: 'hfile1', label: '4.过 Bloom' }],
    'BLOOM',
    'Bloom Filter 过滤'
  )

  // 步骤 5：查 HFile 命中
  push(
    'HFile-1 通过 Bloom，读取得到 Cell（命中），短路返回，不再查其余 HFile',
    18,
    [
      { name: 'hfilesScanned', value: '1', line: 16, type: 'int' },
      { name: 'cell', value: 'row1:cf1:q1=v3', line: 18, type: 'Cell' },
    ],
    makeElements('hfile1').map((e) =>
      e.id === 'hfile1' ? { ...e, state: 'hit' } : e
    ),
    [{ from: 'regionserver', to: 'hfile1', label: '5.f.get? hit' }],
    'HFILE_HIT',
    '查 HFile-1 (命中)'
  )

  // 步骤 6：多版本合并（MVCC）
  push(
    '多版本合并：MemStore + HFile 各版本按 MVCC 取最新可见版本，共读取 5 个版本',
    23,
    [
      { name: 'mvccRead', value: '5', line: 23, type: 'int' },
      { name: 'result', value: 'v3 (ts最新)', line: 23, type: 'Result' },
    ],
    makeElements('memstore').map((e) => {
      if (e.id === 'memstore' || e.id === 'hfile1')
        return { ...e, state: 'done' }
      return e
    }),
    [{ from: 'hfile1', to: 'regionserver', label: '6.合并版本' }],
    'MERGE',
    '多版本合并 (MVCC)'
  )

  // 步骤 7：返回 Client
  push(
    '读路径完成：短路返回（BlockCache 未命中→MemStore 空→HFile-1 命中）',
    23,
    [
      { name: 'cacheHit', value: 'false', line: 7, type: 'boolean' },
      { name: 'bloomCheck', value: '3', line: 16, type: 'int' },
      { name: 'hfilesScanned', value: '1', line: 16, type: 'int' },
      { name: 'mvccRead', value: '5', line: 23, type: 'int' },
    ],
    makeElements('client').map((e) =>
      e.id === 'client' ? { ...e, state: 'done' } : e
    ),
    [{ from: 'regionserver', to: 'client', label: '7.返回 Result' }],
    'DONE',
    '读路径完成'
  )

  return steps
}
