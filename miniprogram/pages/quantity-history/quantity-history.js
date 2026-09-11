// pages/quantity-history/quantity-history.js 商品数量变动记录
const { db, callReportOps } = require("../../utils/cloud");
const { fmtDateTime, toDate } = require("../../utils/format");
const { fetchPurchaseStates, markOf } = require("../../utils/purchaseState");

// purchase-edit（在进货明细里改数量）视作发票类；标签区分「发票/进货」，但都归「发票」筛选组、都可点进同一进货明细
const SOURCE_MAP = { manual: "手动", invoice: "发票", report: "报表", "purchase-edit": "进货" };
// 记录来源 → 所属筛选组
const groupOf = (source) => {
  if (source === "purchase-edit" || source === "invoice") return "invoice";
  if (source === "report") return "report";
  return "manual"; // manual 及未知来源
};

Page({
  data: {
    productId: "",
    name: "",
    filter: "all", // all | manual | invoice | report
    list: [],
    loading: true,
  },

  onLoad(options) {
    const name = options.name ? decodeURIComponent(options.name) : "";
    this.setData({ productId: options.productId || "", name });
    if (name) wx.setNavigationBarTitle({ title: name + " · 数量记录" });
  },

  onShow() {
    this.load();
  },

  async load() {
    if (!this.data.productId) return;
    this.setData({ loading: true });
    try {
      const res = await db()
        .collection("quantityHistory")
        .where({ productId: this.data.productId })
        .orderBy("changeTime", "desc")
        .limit(100)
        .get();
      const list = res.data.map((h) => {
        const d = toDate(h.changeTime);
        const delta = Number(h.delta) || 0;
        const source = h.source || "manual";
        const group = groupOf(source);
        const purchaseId = h.purchaseId || "";
        const reportId = h.reportId || "";
        return {
          ...h,
          source,
          group,
          sourceText: SOURCE_MAP[source] || h.source || "手动",
          timeText: d ? fmtDateTime(d) : "",
          deltaText: (delta > 0 ? "+" : "") + delta,
          deltaClass: delta > 0 ? "up" : delta < 0 ? "down" : "",
          // 补记的老记录没有当时库存值 → 显示 —
          afterText: Number.isFinite(Number(h.after)) ? Number(h.after) : "—",
          purchaseId,
          reportId,
          // 发票/进货需关联到进货记录、报表需 reportId 才能点击跳转
          linkable: (group === "invoice" && !!purchaseId) || (group === "report" && !!reportId),
        };
      });
      // 来源发票被软删（回收站）/ 彻底删除 → 灰显标注并禁止跳转
      const states = await fetchPurchaseStates(
        list.filter((l) => l.group === "invoice").map((l) => l.purchaseId)
      );
      const marked = list.map((l) => {
        const m = markOf(states, l.purchaseId);
        // 发票已彻底删除：明细页已不存在，点不开
        return Object.assign({}, l, m, { linkable: l.linkable && m.canOpen });
      });
      // 待补齐关联的旧发票/进货记录数量（底部按钮由此显隐）
      const pendingCount = marked.filter((l) => l.group === "invoice" && !l.purchaseId).length;
      this.setData({ list: marked, pendingCount });
    } catch (e) {
      console.error("数量记录加载失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  setFilter(e) {
    const filter = e.currentTarget.dataset.filter;
    if (filter === this.data.filter) return;
    this.setData({ filter });
  },

  // 长按记录删除
  onDeleteRecord(e) {
    const id = e.currentTarget.dataset.id;
    const record = this.data.list.find((it) => it._id === id);
    if (!record) return;
    wx.showModal({
      title: "删除记录",
      content: "确定删除这条数量变动记录吗？",
      confirmColor: "#fa5151",
      success: (res) => {
        if (!res.confirm) return;
        db()
          .collection("quantityHistory")
          .doc(id)
          .remove()
          .then(() => {
            wx.showToast({ title: "已删除" });
            this.load();
          })
          .catch((err) => {
            console.error("删除数量记录失败", err);
            wx.showToast({ title: "删除失败", icon: "none" });
          });
      },
    });
  },

  // 点击记录：发票/进货 → 对应进货明细页；报表 → 对应报表详情页
  onCardTap(e) {
    const ds = e.currentTarget.dataset || {};
    // 来源发票已彻底删除：不再跳转（跳过去明细页也是空的），给一句明确提示
    if (ds.purchaseState === "purged") {
      wx.showToast({ title: "该发票已彻底删除", icon: "none" });
      return;
    }
    const source = ds.source || "";
    const purchaseId = ds.purchaseId || "";
    const reportId = ds.reportId || "";
    const group = groupOf(source);
    if (group === "report") {
      if (!reportId) {
        wx.showToast({ title: "该记录未关联报表", icon: "none" });
        return;
      }
      wx.navigateTo({ url: "/pages/report-detail/report-detail?id=" + reportId });
    } else if (group === "invoice") {
      if (!purchaseId) {
        wx.showToast({ title: "未关联进货记录，可点下方按钮补齐", icon: "none" });
        return;
      }
      wx.navigateTo({ url: "/pages/purchase-detail/purchase-detail?id=" + purchaseId });
    }
    // 手动记录无来源单据，不跳转
  },

  // 补齐发票/进货旧记录的 purchaseId：按 商品名+时间 就近匹配对应进货记录并写回
  onLinkBackfill() {
    const pid = this.data.productId;
    if (!pid) return;
    wx.showModal({
      title: "补齐发票关联",
      content:
        "将读取本商品全部「发票/进货」来源、尚未关联的旧数量记录，按时间就近匹配对应进货记录并写入关联。\n\n" +
        "匹配后这些记录点击即可打开对应进货明细。",
      confirmColor: "#07c160",
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: "匹配中…", mask: true });
        try {
          const r = await callReportOps("backfillQtyPurchase", { productId: pid });
          const rr = r && r.result;
          if (rr && rr.success) {
            const msg = rr.total
              ? `已关联 ${rr.matched} 条` + (rr.unmatched ? `，未匹配 ${rr.unmatched} 条` : "")
              : "没有需要关联的记录";
            wx.showToast({ title: msg, icon: "none" });
            this.load();
          } else {
            wx.showToast({ title: (rr && rr.msg) || "补齐失败", icon: "none" });
          }
        } catch (e) {
          console.error("补齐发票关联失败", e);
          wx.showToast({ title: "补齐失败", icon: "none" });
        } finally {
          wx.hideLoading();
        }
      },
    });
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  // 重建数量记录：按该商品全部数量记录（含手动，手动真实增减）重算当前库存
  async onRebuildQty() {
    const pid = this.data.productId;
    if (!pid) return;
    wx.showLoading({ title: "计算中…" });
    try {
      const res = await callReportOps("rebuildQuantity", { productId: pid, dryRun: true });
      const r = res.result;
      if (!r || !r.success) {
        wx.showToast({ title: (r && r.msg) || "计算失败", icon: "none" });
        return;
      }
      let lines = Object.keys(r.computed).map(
        (u) => `${u}: ${Number(r.old[u]) || 0} → ${Number(r.computed[u]) || 0}`
      );
      if (lines.length > 5) {
        lines = lines.slice(0, 5).concat("…");
      }
      const content =
        "将按该商品全部数量变动记录（含手动，手动真实增减）重算库存，并保留所有记录；是否删除旧手动记录由你随后自行决定。\n\n" +
        lines.join("\n") +
        "\n\n确认重建？";
      wx.showModal({
        title: "重建数量记录",
        content,
        confirmColor: "#fa5151",
        success: (res2) => {
          if (res2.confirm) this._doRebuild(pid);
        },
      });
    } catch (e) {
      console.error("重建预览失败", e);
      wx.showToast({ title: "计算失败", icon: "none" });
    } finally {
      wx.hideLoading();
    }
  },

  async _doRebuild(pid) {
    wx.showLoading({ title: "重建中…" });
    try {
      const res = await callReportOps("rebuildQuantity", { productId: pid, dryRun: false });
      const r = res.result;
      if (r && r.success) {
        wx.showToast({
          title: r.addedLedger ? `已重建，补记${r.addedLedger}条出库` : "已重建",
          icon: "success",
        });
        this.load();
      } else {
        wx.showToast({ title: (r && r.msg) || "重建失败", icon: "none" });
      }
    } catch (e) {
      console.error("重建失败", e);
      wx.showToast({ title: "重建失败", icon: "none" });
    } finally {
      wx.hideLoading();
    }
  },
});
