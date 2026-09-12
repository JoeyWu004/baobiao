// pages/changelog/changelog.js 更新日志（我的 → 更新日志）
const { CURRENT_VERSION, CHANGELOG } = require("../../utils/changelog");

// 条目类型 → 标签配色 class（新增绿 / 优化蓝 / 修复橙）
const TYPE_CLASS = {
  新增: "tag-add",
  优化: "tag-opt",
  修复: "tag-fix",
};

Page({
  data: {
    currentVersion: CURRENT_VERSION,
    latestDate: "",
    versions: [],
  },

  onLoad() {
    // 预挂 class：WXML 里没法按中文 type 拼 class，统一在这里算好
    const versions = CHANGELOG.map((v) => ({
      version: v.version,
      commit: v.commit || "",
      date: v.date,
      items: (v.items || []).map((it) => ({
        type: it.type,
        text: it.text,
        cls: TYPE_CLASS[it.type] || "tag-opt",
      })),
    }));
    this.setData({
      versions,
      latestDate: (versions[0] && versions[0].date) || "",
    });
  },
});
