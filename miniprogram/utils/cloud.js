// utils/cloud.js 云开发封装
// 商品库数据量大、操作频繁，走客户端直连数据库；报表/价格历史走 reportOps 云函数。

// 商品库直连数据库实例（products 集合权限：仅创建者可读写）
function db() {
  return wx.cloud.database();
}

// 调用 reportOps 云函数
function callReportOps(action, data = {}) {
  return wx.cloud.callFunction({
    name: "reportOps",
    data: Object.assign({ action }, data),
  });
}

// 调用 exportExcel 云函数
function callExportExcel(data = {}) {
  return wx.cloud.callFunction({
    name: "exportExcel",
    data,
  });
}

// 调用 userOps 云函数
function callUserOps(action, data = {}) {
  return wx.cloud.callFunction({
    name: "userOps",
    data: Object.assign({ action }, data),
  });
}

module.exports = {
  db,
  callReportOps,
  callExportExcel,
  callUserOps,
};
