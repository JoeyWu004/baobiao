// utils/recognition.js 后台发票识别任务
// App 级驱动：创建 recognitionJobs 记录后，由本模块在上传/识别循环中逐步推进，
// 每张结果落库（results[i]、files[i]、done/success/failed），小程序被杀后可凭 done 续跑。
// 页面（goods/发票/确认页）通过 subscribe / getState 感知进度，无需常驻浮窗。
// 配套：云控制台需新建集合 recognitionJobs，权限「仅创建者可读写」。
const { db, callReportOps } = require("./cloud");

const TAB_GOODS_INDEX = 1; // tabBar 顺序：报表0 进货1 地图2 我的3

const _listeners = [];
let _state = {
  jobId: "",
  status: "idle", // idle | running | done | partial | failed | confirmed | cancelled
  total: 0,
  done: 0,
  success: 0,
  failed: 0,
};
let _running = false; // 驱动循环是否在跑（防止重复启动）
let _notifiedJobId = ""; // 完成弹窗已提示过的任务（保证只弹一次）

function getState() {
  return _state;
}

function lastNotified() {
  return _notifiedJobId;
}

function markNotified(jobId) {
  _notifiedJobId = jobId;
}

function subscribe(cb) {
  _listeners.push(cb);
  return () => {
    const i = _listeners.indexOf(cb);
    if (i >= 0) _listeners.splice(i, 1);
  };
}

function setState(partial) {
  _state = Object.assign({}, _state, partial);
  // 同步「进货」tab 角标：有任务在跑 / 有结果待确认 → 红点
  try {
    const active =
      _state.status === "running" ||
      _state.status === "done" ||
      _state.status === "partial" ||
      _state.status === "failed";
    if (active) {
      wx.setTabBarBadge({ index: TAB_GOODS_INDEX, text: "" });
    } else {
      wx.removeTabBarBadge({ index: TAB_GOODS_INDEX });
    }
  } catch (e) {}
  _listeners.forEach((cb) => {
    try {
      cb(_state);
    } catch (e) {}
  });
}

// ---------- 数据库 ----------

function getJob(jobId) {
  return db()
    .collection("recognitionJobs")
    .doc(jobId)
    .get()
    .then((r) => r.data || null)
    .catch(() => null);
}

function updateJob(jobId, data) {
  return db()
    .collection("recognitionJobs")
    .doc(jobId)
    .update({ data: Object.assign({ updateTime: db().serverDate() }, data) })
    .catch((e) => console.error("updateJob error", e));
}

// ---------- 创建任务 ----------

// 同一时间只允许一个任务（查库兜底，防止冷启动后内存态缺失）
// 入参可为路径字符串，也可为 { path, digest }（digest 用于防重复上传）
async function createJob(imageList) {
  const list = (imageList || [])
    .map((x) =>
      typeof x === "string"
        ? { path: x, digest: "" }
        : { path: x.path || "", digest: x.digest || "" }
    )
    .filter((x) => x.path);
  if (!list.length) throw new Error("没有图片");
  const run = await db()
    .collection("recognitionJobs")
    .where({ status: "running" })
    .limit(1)
    .get();
  if (run.data.length > 0) {
    throw new Error("已有识别任务在进行中");
  }
  const addRes = await db().collection("recognitionJobs").add({
    data: {
      status: "running",
      files: list.map((x) => ({ path: x.path, fileID: "", failed: false, digest: x.digest })),
      results: list.map(() => null),
      total: list.length,
      done: 0,
      success: 0,
      failed: 0,
      createTime: db().serverDate(),
      updateTime: db().serverDate(),
    },
  });
  startJob(addRes._id);
  return addRes._id;
}

// 历史已成功识别/已确认的图片指纹集合，供发票页防重复上传。
// 由 reportOps.seenInvoiceDigests 计算：只有「该图片仍对应当前未删除的进货记录」才算已导入，
// 发票被删除并清空回收站后不再拦截，允许重新导入同一张发票。
async function seenDigests() {
  try {
    const r = await callReportOps("seenInvoiceDigests");
    const res = r.result || {};
    if (!res.success) return new Set();
    return new Set((res.digests || []).filter(Boolean));
  } catch (e) {
    console.error("seenDigests error", e);
    return new Set();
  }
}

// 启动/续跑（幂等：已在跑则忽略）
async function startJob(jobId) {
  if (_running) return;
  setState({ jobId, status: "running" });
  _running = true;
  try {
    await runLoop(jobId);
  } catch (e) {
    console.error("识别任务异常", e);
  } finally {
    _running = false;
  }
}

function compress(src) {
  return new Promise((resolve, reject) => {
    wx.compressImage({
      src,
      quality: 70,
      success: (r) => resolve(r.tempFilePath),
      fail: reject,
    });
  });
}

function mimeOf(fileID) {
  const ext = (fileID.match(/\.(\w+)$/) || [, "jpg"])[1].toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

// 逐张处理：压缩→上传（未传过）→ OCR → 结果整批落库；每张完成后 done=i+1
async function runLoop(jobId) {
  let job = await getJob(jobId);
  if (!job || job.status !== "running") return;
  const total = job.total || (job.files || []).length;
  const files = job.files || [];

  for (let i = job.done; i < total; i++) {
    // 每张处理前确认任务没被取消
    const cur = await getJob(jobId);
    if (!cur || cur.status !== "running") return;

    const fileList = cur.files && cur.files.length === total ? cur.files.slice() : files.slice();
    const results = cur.results && cur.results.length === total ? cur.results.slice() : files.map(() => null);
    let success = cur.success || 0;
    let failed = cur.failed || 0;
    setState({ jobId, done: i, total });

    try {
      let fileID = (fileList[i] && fileList[i].fileID) || "";
      if (!fileID) {
        const path = (fileList[i] && fileList[i].path) || "";
        if (!path) throw new Error("图片本地路径已失效");
        const compressed = await compress(path);
        const ext = (path.match(/\.(\w+)$/) || [, "jpg"])[1].toLowerCase();
        const up = await wx.cloud.uploadFile({
          cloudPath: "invoices/" + jobId + "-" + i + "." + ext,
          filePath: compressed,
        });
        fileID = up.fileID;
        fileList[i] = Object.assign({}, fileList[i], { fileID });
      }
      const res = await wx.cloud.callFunction({
        name: "invoiceOCR",
        data: { action: "recognize", fileID, mimeType: mimeOf(fileID) },
      });
      if (res.result && res.result.success) {
        success += 1;
        results[i] = {
          items: res.result.items || [],
          supplier: res.result.supplier || "",
          date: res.result.date || "",
          title: res.result.title || "",
          fileID,
          model: res.result.model || "",
        };
      } else {
        failed += 1;
        fileList[i] = Object.assign({}, fileList[i], { failed: true });
      }
    } catch (e) {
      console.error("第 " + (i + 1) + " 张识别失败", e);
      failed += 1;
      if (fileList[i]) fileList[i] = Object.assign({}, fileList[i], { failed: true });
    }

    await updateJob(jobId, { files: fileList, results, success, failed, done: i + 1 });
    setState({ jobId, done: i + 1, success, failed });
  }

  // 收尾：全部跑完才改终态
  const fin = await getJob(jobId);
  if (!fin || fin.status !== "running") return;
  const status = fin.success > 0 ? (fin.failed > 0 ? "partial" : "done") : "failed";
  await updateJob(jobId, { status, done: fin.total });
  setState({
    jobId,
    status,
    done: fin.total,
    total: fin.total,
    success: fin.success,
    failed: fin.failed,
  });
}

// App 启动 / 回前台：续跑未完成任务
async function resume() {
  if (_running) return;
  try {
    const res = await db()
      .collection("recognitionJobs")
      .where({ status: "running" })
      .orderBy("createTime", "desc")
      .limit(1)
      .get();
    if (res.data.length > 0) {
      const job = res.data[0];
      setState({
        jobId: job._id,
        status: "running",
        total: job.total || 0,
        done: job.done || 0,
        success: job.success || 0,
        failed: job.failed || 0,
      });
      startJob(job._id);
    }
  } catch (e) {}
}

// 从数据库刷新内存态（供页面 onShow 同步）
async function refresh() {
  try {
    const res = await db()
      .collection("recognitionJobs")
      .orderBy("createTime", "desc")
      .limit(1)
      .get();
    if (res.data.length === 0) {
      setState({ status: "idle", jobId: "" });
      return;
    }
    const j = res.data[0];
    if (j.status === "running") {
      setState({
        jobId: j._id, status: "running", total: j.total || 0,
        done: j.done || 0, success: j.success || 0, failed: j.failed || 0,
      });
    } else if (j.status === "done" || j.status === "partial" || j.status === "failed") {
      setState({
        jobId: j._id, status: j.status, total: j.total || 0,
        done: j.done || 0, success: j.success || 0, failed: j.failed || 0,
      });
    } else {
      setState({ status: "idle", jobId: "" });
    }
  } catch (e) {}
}

// 进入确认页后标记已处理，清除角标
async function confirmViewed() {
  const jobId = _state.jobId;
  if (!jobId) return;
  await updateJob(jobId, { status: "confirmed" });
  setState({ status: "confirmed", jobId });
}

// 取消当前任务（已识别的结果保留在库里，但不再提示）
async function cancel() {
  const jobId = _state.jobId;
  if (!jobId) return;
  await updateJob(jobId, { status: "cancelled" });
  setState({ status: "cancelled", jobId: "" });
}

// 取最近一次完成的任务（供确认页读结果）
// 优先取有结果的任务（done/partial）；最新的 failed 任务（无结果）不覆盖它
async function getLatestFinished() {
  try {
    const cmd = db().command;
    const res = await db()
      .collection("recognitionJobs")
      .where({ status: cmd.in(["done", "partial", "failed"]) })
      .orderBy("createTime", "desc")
      .limit(5)
      .get();
    const jobs = res.data || [];
    return (
      jobs.find((j) => j.status === "done" || j.status === "partial") ||
      jobs[0] ||
      null
    );
  } catch (e) {
    return null;
  }
}

module.exports = {
  getState,
  subscribe,
  lastNotified,
  markNotified,
  createJob,
  seenDigests,
  startJob,
  resume,
  refresh,
  confirmViewed,
  cancel,
  getLatestFinished,
};
