// 纯函数工具：把画布上的图片节点「按视觉网格合并回一张图」，以及把「拖入的多个文件整齐摆成网格」。
// 本文件不依赖 React / DOM，无副作用，全部为确定性纯函数，便于在任意上下文复用与测试。

/** 网格推断所需的最小节点形状（中心点由 position + 尺寸算出）。 */
type GridNodeShape = {
    id: string;
    position: { x: number; y: number };
    width: number;
    height: number;
};

/** 内部用：取数值数组的中位数（空数组返回 0）。用于按节点尺寸自适应聚类容差。 */
function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * 一维贪心聚类：把带索引的数值序列按「与当前桶的运行均值之差是否超过容差」切分成桶。
 * 先按轴值升序排序，再顺序扫描；超过容差则新开一个桶。返回每个原始索引所属的桶序号。
 */
function clusterAxis(samples: { index: number; value: number }[], tolerance: number): number[] {
    const order = [...samples].sort((a, b) => a.value - b.value);
    const bucketOf = new Array<number>(samples.length).fill(0);
    let bucket = 0;
    let runningSum = 0;
    let runningCount = 0;

    for (const sample of order) {
        const mean = runningCount === 0 ? sample.value : runningSum / runningCount;
        // 新桶判定：仅当已有样本、且当前值超出运行均值容差范围时才切桶。
        if (runningCount > 0 && sample.value - mean > tolerance) {
            bucket += 1;
            runningSum = 0;
            runningCount = 0;
        }
        bucketOf[sample.index] = bucket;
        runningSum += sample.value;
        runningCount += 1;
    }

    return bucketOf;
}

/**
 * 根据节点在画布上的位置，推断它们排成的 行×列 网格，并给出行优先（row-major）的格子顺序。
 * 用途：用户把图片节点摆成网格后框选，能按「肉眼可见的视觉顺序」把它们合并回一张大图。
 *
 * 算法：
 *  - 每个节点取中心 cx=position.x+width/2、cy=position.y+height/2。
 *  - 用一维贪心聚类把 Y 分成「行桶」、X 分成「列桶」：容差 行=0.5*中位高度、列=0.5*中位宽度，
 *    以吸收切分单元格之间的尺寸差异与漂移（重新生成的某格尺寸可能略有不同）。
 *  - 行序号自上而下、列序号自左而右；每个节点得到 (rowIdx, colIdx)。
 *  - 校验「干净网格」：rows*cols === 节点数，且每个 (r,c) 槽位恰好被填一次。
 *    通过则按行优先建 cells[r][c]=node.id 返回 { rows, cols, cells }；否则（参差/重叠/重复槽位/质数个数）返回 null。
 */
export function inferGridFromPositions<T extends GridNodeShape>(
    nodes: T[],
): { rows: number; cols: number; cells: (string | null)[][] } | null {
    if (nodes.length === 0) return null;

    const centers = nodes.map((node) => ({
        cx: node.position.x + node.width / 2,
        cy: node.position.y + node.height / 2,
    }));

    const rowTolerance = 0.5 * median(nodes.map((node) => node.height));
    const colTolerance = 0.5 * median(nodes.map((node) => node.width));

    // 按 Y 聚行、按 X 聚列。
    const rowBucket = clusterAxis(centers.map((c, index) => ({ index, value: c.cy })), rowTolerance);
    const colBucket = clusterAxis(centers.map((c, index) => ({ index, value: c.cx })), colTolerance);

    const rows = Math.max(...rowBucket) + 1;
    const cols = Math.max(...colBucket) + 1;

    // 校验①：行×列必须正好等于节点数（排除质数/参差等不可整齐排布的情况）。
    if (rows * cols !== nodes.length) return null;

    // 行优先填格，并校验②：每个槽位恰好被填一次（无空缺、无重复）。
    const cells: (string | null)[][] = Array.from({ length: rows }, () => new Array<string | null>(cols).fill(null));
    for (let i = 0; i < nodes.length; i += 1) {
        const r = rowBucket[i];
        const c = colBucket[i];
        if (cells[r][c] !== null) return null;
        cells[r][c] = nodes[i].id;
    }
    for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
            if (cells[r][c] === null) return null;
        }
    }

    return { rows, cols, cells };
}

/**
 * 当位置推断失败（返回 null）时的兜底列数：给出一个接近正方形的列数。
 * 先查小映射表，命中常见个数；否则用 Math.ceil(Math.sqrt(n))。n<=0 时保护性返回 1。
 */
export function gridColumnsForCount(n: number): number {
    if (n <= 0) return 1;
    const map: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 2, 6: 3, 8: 4, 9: 3, 12: 4, 16: 4 };
    return map[n] ?? Math.ceil(Math.sqrt(n));
}

/**
 * 计算行优先网格中 count 个槽位的「中心点」坐标，用于把 N 个上传文件预摆成不重叠的网格。
 * anchor 是 (0,0) 槽的中心，网格向右、向下生长。cols 默认取 gridColumnsForCount(count)。
 * 第 i 个槽：row=floor(i/cols)、col=i%cols；cx=anchor.x+col*(cellW+gap)、cy=anchor.y+row*(cellH+gap)。
 */
export function computeGridSlots(
    count: number,
    anchor: { x: number; y: number },
    cellW: number,
    cellH: number,
    gap: number,
    cols?: number,
): { cx: number; cy: number }[] {
    const columns = cols ?? gridColumnsForCount(count);
    const slots: { cx: number; cy: number }[] = [];
    for (let i = 0; i < count; i += 1) {
        const row = Math.floor(i / columns);
        const col = i % columns;
        slots.push({
            cx: anchor.x + col * (cellW + gap),
            cy: anchor.y + row * (cellH + gap),
        });
    }
    return slots;
}
