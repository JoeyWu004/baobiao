// pages/price-history/price-history.js 商品价格历史（顶部波动图 + 筛选 + 列表）
const { db, callReportOps } = require("../../utils/cloud");
const { fmtMoney, fmtDateTime, toDate } = require("../../utils/format");
const { drawPriceChart } = require("../../utils/priceChart");

Page({
  data: {
    productId: "",
    name: "",
    filter: "all", // all | cost | sell
    list: [],
    loading: true,
    hasData: false,
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
        return {
          ...h,
          timeMs: d ? d.getTime() : 0,
          timeText: d ? fmtDateTime(d) : "",
          oldText: fmtMoney(h.oldPrice),
          newText: fmtMoney(h.newPrice),
          typeLabel: h.priceType === "cost" ? "进价" : "售价",
          typeClass: h.priceType === "cost" ? "tag-cost" : "tag-sell",
        };
      });
      this.setData({ list, hasData: list.length > 0 });
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
