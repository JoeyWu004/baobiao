// pages/map/map.js 地图页：展示报表记录的位置，按状态筛选，支持上一个/下一个
const { callReportOps } = require("../../utils/cloud");
const { fmtMoney } = require("../../utils/format");
const { ensureLogin } = require("../../utils/auth");

// 默认中心（北京），无定位数据时使用
const DEFAULT_CENTER = { latitude: 39.909, longitude: 116.397 };

// 按状态区分标记颜色
const MARKER_ICONS = {
  pending: "/images/markers/marker-pending.png", // 灰
  doing: "/images/markers/marker-doing.png", // 橙
  done: "/images/markers/marker-done.png", // 绿
};

const STATUS_TABS = [
  { key: "all", text: "全部" },
  { key: "pending", text: "待完成" },
  { key: "doing", text: "进行中" },
  { key: "done", text: "已完成" },
];

Page({
  data: {
    center: { ...DEFAULT_CENTER },
    scale: 12,
    markers: [],
    loading: true,
    statusFilter: "all",
    statusTabs: STATUS_TABS,
    hasAny: false,
    navIndex: 0, // 当前标记索引（上一个/下一个用）
    showCallout: true, // 标记点的白色气泡是否显示（点地图可切换）
  },

  onShow() {
    ensureLogin();
    this.loadLocations();
  },

  async loadLocations() {
    this.setData({ loading: true });
    try {
      const res = await callReportOps("listReports", { limit: 50 });
      const list = (res.result && res.result.list) || [];
      const all = [];
      let first = null;

      list.forEach((r) => {
        if (
          r.location &&
          r.location.latitude != null &&
          r.location.longitude != null
        ) {
          const item = {
            latitude: r.location.latitude,
            longitude: r.location.longitude,
            status: r.status || "pending",
            customerName: r.customerName,
            totalAmount: r.totalAmount,
            reportId: r._id,
          };
          if (!first) first = { latitude: item.latitude, longitude: item.longitude };
          all.push(item);
        }
      });

      this._all = all;
      // 状态数量统计
      const counts = { all: all.length, pending: 0, doing: 0, done: 0 };
      all.forEach((it) => {
        counts[it.status] = (counts[it.status] || 0) + 1;
      });
      const statusTabs = STATUS_TABS.map((t) => ({
        ...t,
        count: t.key === "all" ? counts.all : counts[t.key] || 0,
      }));

      this.setData({
        hasAny: all.length > 0,
        center: first || this.data.center,
        statusTabs,
        navIndex: 0,
      });
      this.renderMarkers();
    } catch (e) {
      console.error("加载位置失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 按当前状态筛选生成标记点
  renderMarkers() {
    const filter = this.data.statusFilter;
    const all = this._all || [];
    const markers = all
      .filter((it) => filter === "all" || it.status === filter)
      .map((it, i) => {
        const marker = {
          id: i,
          latitude: it.latitude,
          longitude: it.longitude,
          width: 30,
          height: 30,
          iconPath: MARKER_ICONS[it.status] || MARKER_ICONS.pending,
          reportId: it.reportId,
        };
        if (this.data.showCallout) {
          marker.callout = {
            content: `${it.customerName} ¥${fmtMoney(it.totalAmount)}`,
            display: "ALWAYS",
            fontSize: 13,
            borderRadius: 6,
            padding: 8,
            bgColor: "#ffffff",
            color: "#333333",
          };
        }
        return marker;
      });
    // 调整索引不越界
    let navIndex = this.data.navIndex;
    if (markers.length === 0) navIndex = 0;
    else if (navIndex >= markers.length) navIndex = markers.length - 1;
    this.setData({ markers, navIndex });
  },

  setStatusFilter(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.statusFilter) return;
    this.setData({ statusFilter: key, navIndex: 0 });
    this.renderMarkers();
  },

  // 定位到某个标记
  centerOnMarker(idx) {
    const m = this.data.markers[idx];
    if (!m) return;
    this.setData({
      navIndex: idx,
      center: { latitude: m.latitude, longitude: m.longitude },
      scale: 15,
    });
  },

  goPrev() {
    const len = this.data.markers.length;
    if (!len) return;
    this.centerOnMarker((this.data.navIndex - 1 + len) % len);
  },

  goNext() {
    const len = this.data.markers.length;
    if (!len) return;
    this.centerOnMarker((this.data.navIndex + 1) % len);
  },

  onMarkerTap(e) {
    const id = e.detail.markerId;
    const idx = this.data.markers.findIndex((m) => m.id === id);
    if (idx >= 0) this.setData({ navIndex: idx });
    const marker = this.data.markers[idx];
    if (marker && marker.reportId) {
      wx.navigateTo({
        url: "/pages/report-detail/report-detail?id=" + marker.reportId,
      });
    }
  },

  locateMe() {
    wx.getLocation({
      type: "gcj02",
      success: (res) => {
        this.setData({
          center: { latitude: res.latitude, longitude: res.longitude },
          scale: 14,
        });
      },
      fail: () => wx.showToast({ title: "定位失败", icon: "none" }),
    });
  },

  // 点地图：切换标记气泡（白色文本框）显示/隐藏
  toggleCallout() {
    this.setData({ showCallout: !this.data.showCallout });
    this.renderMarkers();
  },
});
