// pages/price-history/price-history.js 商品价格历史（顶部波动图 + 筛选 + 列表）
const { db, callReportOps } = require("../../utils/cloud");
const { fmtMoney, fmtDateTime, toDate } = require("../../utils/format");
const { drawPriceChart } = require("../../utils/priceChart");

// 价格变动原因 → 展示文案；来源与所属组（发票/进货都归「发票」组，可点跳同一进货明细）
const SOURCE_MAP = { manual: "手动", invoice: "发票", report: "报表", "purchase-edit": "进货" };
const groupOf = (source) => {
  if (source === "invoice" || source === "purchase-edit") return "invoice";
  if (source === "report") return "report";
  if (source === "manual") return "manual";
  return ""; // 旧记录未标注来源
};

Page({
  data: {
    productId: "",
    name: "",
    filter: "all", // all | cost | sell
    list: [],
    loading: true,
    hasData: false,
    syncing: false,
    pendingCount: 0,
  },

  onLoad(options) {
    const name = options.name ? decodeURIComponent(options.name) : "";
    this.setData({ productId: options.productId || "", name });
    if (name) {
      wx.setNavigationBarTitle({ title: name + " · 价格历史" });
    }
  },

  onShow() {
    this.load();
  },

  async load() {
    if (!this.data.productId) return;
    this.setData({ loading: true });
    try {
      const res = await callReportOps("getPriceHistory", {
        productId: this.data.productId,
      });
      if (!res.result || !res.result.success) {
        throw new Error((res.result && res.result.msg) || "加载失败");
      }
      const list = res.result.list.map((h) => {
        const d = toDate(h.changeTime);
        const source = h.source || "";
        const group = groupOf(source);
        const purchaseId = h.purchaseId || "";
        const reportId = h.reportId || "";
        return {
          ...h,
          timeMs: d ? d.getTime() : 0,
          timeText: d ? fmtDateTime(d) : "",
          oldText: fmtMoney(h.oldPrice),
          newText: fmtMoney(h.newPrice),
          typeLabel: h.priceType === "cost" ? "进价" : "售价",
          typeClass: h.priceType === "cost" ? "tag-cost" : "tag-sell",
          source,
          group,
          sourceText: SOURCE_MAP[source] || "",
          purchaseId,
          reportId,
          // 报表→报表详情；发票/进货→进货明细
          linkable: (group === "report" && !!reportId) || (group === "invoice" && !!purchaseId),
        };
      });
      // 尚未标注来源的旧记录数（底部「补齐来源」按钮由此显隐）
      const pendingCount = list.filter((l) => !l.source).length;
      this.setData({ list, hasData: list.length > 0, pendingCount });
      wx.nextTick(() => this.renderChart());
    } catch (e) {
      console.error("价格历史加载失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  setFilter(e) {
    const filter = e.currentTarget.dataset.filter;
    if (filter === this.data.filter) return;
    this.setData({ filter });
    this.renderChart();
  },

  // 把最近一次报表售价同步到本商品售价（并补一条售价历史），修复历史报表缺 productId 未同步的商品
  async onSyncPrice() {
    const pid = this.data.productId;
    if (!pid || this.data.syncing) return;
    this.setData({ syncing: true });
    wx.showLoading({ title: "查询中…" });
    try {
      const res = await callReportOps("syncReportPrice", { productId: pid, dryRun: true });
      const r = res && res.result;
      if (!r || !r.success) {
        wx.hideLoading();
        this.setData({ syncing: false });
        wx.showToast({ title: (r && r.msg) || "查询失败", icon: "none" });
        return;
      }
      wx.hideLoading();
      this.setData({ syncing: false });
      if (!r.hasSale) {
        wx.showToast({ title: "该商品还没有报表售价记录", icon: "none" });
        return;
      }
      if (!r.changed) {
        wx.showToast({ title: "售价已是最新", icon: "none" });
        return;
      }
      const src = r.reportDate
        ? `「${r.reportTitle || "报表"}」(${r.reportDate}${r.customer ? " · " + r.customer : ""})`
        : "最近报表";
      wx.showModal({
        title: "同步最近售价",
        content:
          `将从 ${src} 把「${r.unit}」售价\n¥${fmtMoney(r.oldPrice)} → ¥${fmtMoney(r.newPrice)}\n` +
          "同步到本商品，并记一条售价历史。\n\n确认同步？",
        confirmColor: "#07c160",
        success: async (m) => {
          if (!m.confirm) return;
          this.setData({ syncing: true });
          wx.showLoading({ title: "同步中…", mask: true });
          try {
            const c = await callReportOps("syncReportPrice", { productId: pid, dryRun: false });
            const cr = c && c.result;
            wx.hideLoading();
            this.setData({ syncing: false });
            if (cr && cr.success && cr.changed) {
              wx.showToast({ title: "已同步", icon: "success" });
              this.load();
            } else {
              wx.showToast({ title: (cr && cr.msg) || "同步失败", icon: "none" });
            }
          } catch (e) {
            wx.hideLoading();
            this.setData({ syncing: false });
            console.error("同步售价失败", e);
            wx.showToast({ title: "同步失败", icon: "none" });
          }
        },
      });
    } catch (e) {
      wx.hideLoading();
      this.setData({ syncing: false });
      console.error("同步售价查询失败", e);
      wx.showToast({ title: "查询失败", icon: "none" });
    }
  },

  // 点击价格记录：报表→报表详情；发票/进货→进货明细
  onCardTap(e) {
    const ds = e.currentTarget.dataset || {};
    const group = groupOf(ds.source || "");
    if (group === "report") {
      if (!ds.reportId) return;
      wx.navigateTo({ url: "/pages/report-detail/report-detail?id=" + ds.reportId });
    } else if (group === "invoice") {
      if (!ds.purchaseId) {
        wx.showToast({ title: "未关联进货记录，可点下方按钮补齐", icon: "none" });
        return;
      }
      wx.navigateTo({ url: "/pages/purchase-detail/purchase-detail?id=" + ds.purchaseId });
    }
    // 手动/未标注来源不跳
  },

  // 补齐价格历史旧记录的来源（按 商品名+时间 就近匹配报表/进货记录）
  onBackfillLinks() {
    const pid = this.data.productId;
    if (!pid) return;
    wx.showModal({
      title: "补齐价格来源",
      content:
        "将把该商品尚未标注来源的价格记录，按时间就近匹配对应的报表或进货记录并写入关联。\n\n" +
        "匹配后报表/进货引起的价格变化即可点击直达来源单据。",
      confirmColor: "#07c160",
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: "匹配中…", mask: true });
        try {
          const r = await callReportOps("backfillPriceLinks", { productId: pid });
          const rr = r && r.result;
          wx.hideLoading();
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
          wx.hideLoading();
          console.error("补齐价格来源失败", e);
          wx.showToast({ title: "补齐失败", icon: "none" });
        }
      },
    });
  },

  // 长按记录删除
  onDeleteRecord(e) {
    const id = e.currentTarget.dataset.id;
    const record = this.data.list.find((it) => it._id === id);
    if (!record) return;
    wx.showModal({
      title: "删除记录",
      content: "确定删除这条价格变动记录吗？",
      confirmColor: "#fa5151",
      success: (res) => {
        if (!res.confirm) return;
        db()
          .collection("priceHistory")
          .doc(id)
          .remove()
          .then(() => this.recalcProductPrice(record))
          .then(() => {
            wx.showToast({ title: "已删除" });
            this.load();
          })
          .catch((err) => {
            console.error("删除价格记录失败", err);
            wx.showToast({ title: "删除失败", icon: "none" });
          });
      },
    });
  },

  // 删除后按剩余历史回写商品当前价格：取该(商品+单位+类型)最近一条的 newPrice，无则归 0
  async recalcProductPrice(record) {
    if (!record || !record.productId || !record.unit || !record.priceType) return;
    try {
      const res = await db()
        .collection("priceHistory")
        .where({
          productId: record.productId,
          unit: record.unit,
          priceType: record.priceType,
        })
        .orderBy("changeTime", "desc")
        .limit(1)
        .get();
      const newPrice = res.data.length ? Number(res.data[0].newPrice) || 0 : 0;
      await this.writeProductPrice(record.productId, record.unit, record.priceType, newPrice);
    } catch (e) {
      console.error("重算价格失败", e);
    }
  },

  // 回写商品某单位的售价/进价；默认单位同步顶层字段
  // 只有算出的价格与商品当前价格不同才写库，避免每次删除都做无谓写入
  async writeProductPrice(productId, unit, priceType, newPrice) {
    try {
      const doc = await db().collection("products").doc(productId).get();
      const p = doc.data;
      if (!p) return;
      const field = priceType === "sell" ? "sellPrice" : "costPrice";
      const units =
        Array.isArray(p.units) && p.units.length
          ? p.units.slice()
          : [
              {
                name: p.unit || "个",
                costPrice: p.costPrice || 0,
                sellPrice: p.sellPrice || 0,
                quantity: p.quantity || 0,
              },
            ];
      const idx = units.findIndex((u) => u.name === unit);
      // 单位不存在或价格未变化：不写库
      if (idx < 0) return;
      if (Math.abs(Number(units[idx][field] || 0) - newPrice) < 0.001) return;
      units[idx] = { ...units[idx], [field]: newPrice };
      const updateData = { units, updateTime: db().serverDate() };
      if (units[0].name === unit) {
        updateData[field] = newPrice;
      }
      await db().collection("products").doc(productId).update({ data: updateData });
    } catch (e) {
      console.error("回写商品价格失败", e);
    }
  },

  // 按当前筛选构建系列数据并绘制波动图
  renderChart() {
    if (!this.data.list.length) return;
    const filter = this.data.filter;
    const types = filter === "all" ? ["sell", "cost"] : [filter];
    const seriesList = [];

    types.forEach((t) => {
      const recs = this.data.list
        .filter((r) => r.priceType === t)
        .sort((a, b) => a.timeMs - b.timeMs);
      if (!recs.length) return;
      let current = Number(recs[0].oldPrice);
      const points = [];
      recs.forEach((r) => {
        points.push({ t: r.timeMs, v: current });
        current = Number(r.newPrice);
        points.push({ t: r.timeMs, v: current });
      });
      seriesList.push({
        type: t,
        label: t === "sell" ? "售价" : "进价",
        points,
      });
    });

    this.drawChart(seriesList);
  },

  drawChart(seriesList) {
    this.createSelectorQuery()
      .select("#priceChart")
      .fields({ node: true, size: true })
      .exec((res) => {
        const info = res && res[0];
        if (!info || !info.node) return;
        const canvas = info.node;
        const dpr = wx.getWindowInfo().pixelRatio || 2;
        canvas.width = info.width * dpr;
        canvas.height = info.height * dpr;
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawPriceChart(ctx, info.width, info.height, seriesList);
      });
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },
});
