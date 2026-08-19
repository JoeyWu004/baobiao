// pages/report-detail/report-detail.js 报表详情 + 存图 + 导出
const { callReportOps, callExportExcel } = require("../../utils/cloud");
const { fmtMoney, fmtDateTime, toDate, locText } = require("../../utils/format");
const { renderBillToImages } = require("../../utils/billCanvas");

Page({
  data: {
    report: null,
    reportId: "",
    loading: true,
    totalText: "0.00",
    createTimeText: "",
    exporting: false,
  },

  onLoad(options) {
    if (options.id) {
      this.setData({ reportId: options.id });
    } else {
      wx.showToast({ title: "缺少报表 ID", icon: "none" });
    }
  },

  // onShow 每次出现都刷新，编辑返回后能立即看到最新内容
  onShow() {
    if (this.data.reportId) {
      this.loadReport(this.data.reportId);
    }
  },

  async loadReport(id) {
    this.setData({ loading: true });
    try {
      const res = await callReportOps("getReport", { reportId: id });
      if (!res.result || !res.result.success) {
        throw new Error((res.result && res.result.msg) || "加载失败");
      }
      const r = res.result.report;
      const items = (r.items || []).map((it) => ({
        ...it,
        amountText: fmtMoney(it.amount),
        priceText: fmtMoney(it.price),
      }));
      this.setData({
        report: { ...r, items },
        totalText: fmtMoney(r.totalAmount),
        createTimeText: r.createTime ? fmtDateTime(toDate(r.createTime)) : "",
        locText: locText(r),
      });
    } catch (e) {
      console.error("报表加载失败", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  // ---------- 存为图片 ----------
  async saveAsImage() {
    const report = this.data.report;
    if (!report) return;

    // 权限检查
    const setting = await new Promise((resolve) =>
      wx.getSetting({ success: resolve, fail: () => resolve({}) })
    );
    const auth = setting.authSetting && setting.authSetting["scope.writePhotosAlbum"];
    if (auth === false) {
      wx.showModal({
        title: "需要相册权限",
        content: "请在设置中允许「添加到相册」，才能保存报表图片。",
        confirmText: "去设置",
        success: (m) => {
          if (m.confirm) wx.openSetting();
        },
      });
      return;
    }

    wx.showLoading({ title: "生成图片中…", mask: true });
    try {
      const dpr = wx.getWindowInfo().pixelRatio || 2;
      const paths = await renderBillToImages(report, () => this.createSelectorQuery(), dpr);
      for (const p of paths) {
        await this.saveToAlbum(p);
      }
      wx.hideLoading();
      wx.showToast({
        title: paths.length > 1 ? `已保存 ${paths.length} 张图片` : "已保存到相册",
      });
    } catch (e) {
      wx.hideLoading();
      console.error("存图失败", e);
      this.handleExportError(e, "图片保存失败");
    }
  },

  saveToAlbum(filePath) {
    return new Promise((resolve, reject) => {
      wx.saveImageToPhotosAlbum({
        filePath,
        success: resolve,
        fail: (e) => {
          // 隐私/授权类错误引导用户去设置
          const msg = e.errMsg || "";
          if (msg.includes("auth deny") || msg.includes("authorize")) {
            wx.showModal({
              title: "需要相册权限",
              content: "请在设置中允许「添加到相册」后重试。",
              confirmText: "去设置",
              success: (m) => {
                if (m.confirm) wx.openSetting();
              },
            });
            reject(new Error("authorize"));
          } else if (msg.includes("privacy")) {
            wx.showModal({
              title: "隐私授权未配置",
              content:
                "请在微信公众平台后台「设置-服务内容声明-用户隐私保护指引」中声明「相册（仅写入）」，并启用隐私弹窗。",
              showCancel: false,
            });
            reject(new Error("privacy"));
          } else {
            reject(e);
          }
        },
      });
    });
  },

  // ---------- 导出 Excel ----------
  async exportExcel() {
    const report = this.data.report;
    if (!report || this.data.exporting) return;
    this.setData({ exporting: true });
    wx.showLoading({ title: "生成 Excel…", mask: true });
    try {
      const res = await callExportExcel({ reportId: report._id });
      wx.hideLoading();
      if (!res.result || !res.result.fileID) {
        throw new Error((res.result && res.result.msg) || "导出失败");
      }
      const dl = await wx.cloud.downloadFile({ fileID: res.result.fileID });
      wx.openDocument({
        filePath: dl.tempFilePath,
        fileType: "xlsx",
        showMenu: true, // 支持转发/发送给朋友
        success: () => {},
        fail: (e) => {
          console.error("打开文件失败", e);
          wx.showToast({ title: "打开文件失败", icon: "none" });
        },
      });
    } catch (e) {
      wx.hideLoading();
      console.error("导出失败", e);
      this.handleExportError(e, "Excel 导出失败");
    } finally {
      this.setData({ exporting: false });
    }
  },

  handleExportError(e, msg) {
    const em = (e && e.message) || (e && e.errMsg) || "";
    if (em.includes("not found") || em.includes("FunctionName")) {
      wx.showModal({
        title: "云函数未部署",
        content:
          "请在小程序开发者工具中，右键 cloudfunctions/exportExcel 目录，选择「上传并部署：云端安装依赖」后重试。",
        showCancel: false,
      });
      return;
    }
    wx.showToast({ title: msg, icon: "none" });
  },

  // ---------- 复制文本 ----------
  goEdit() {
    const report = this.data.report;
    if (!report) return;
    wx.navigateTo({ url: "/pages/report-edit/report-edit?id=" + report._id });
  },

  // 打开微信内置地图导航到报表位置；只填文本框未定位时提示先定位
  openNav() {
    const report = this.data.report;
    if (!report) return;
    if (!report.location || report.location.latitude == null) {
      wx.showModal({
        title: "未定位",
        content: "该报表没有定位信息，无法导航。请先到编辑页使用「定位」选择位置。",
        confirmText: "去定位",
        cancelText: "取消",
        success: (res) => {
          if (res.confirm) {
            wx.navigateTo({
              url: "/pages/report-edit/report-edit?id=" + report._id,
            });
          }
        },
      });
      return;
    }
    wx.openLocation({
      latitude: report.location.latitude,
      longitude: report.location.longitude,
      name: report.location.name || report.customerName || "位置",
      address: locText(report) || "",
      scale: 16,
      fail: (e) => {
        console.error("打开地图失败", e);
        wx.showToast({ title: "打开地图失败", icon: "none" });
      },
    });
  },

  copyText() {
    const report = this.data.report;
    if (!report) return;
    const lines = [];
    lines.push(report.title || "报表");
    lines.push("日期：" + report.date + "  客户：" + report.customerName);
    const lt = locText(report);
    if (lt) lines.push("位置：" + lt);
    lines.push("");
    report.items.forEach((it, i) => {
      if (it.type === "goods") {
        lines.push(
          `${i + 1}. ${it.name}  ${it.unit}  ${it.quantity} × ${fmtMoney(it.price)} = ${fmtMoney(it.amount)}`
        );
      } else {
        lines.push(`${i + 1}. ${it.desc}  金额 ¥${fmtMoney(it.amount)}`);
      }
    });
    lines.push("");
    lines.push("合计：¥" + fmtMoney(report.totalAmount));
    if (report.remark) lines.push("备注：" + report.remark);
    if (report.serviceNote) lines.push(report.serviceNote);
    wx.setClipboardData({ data: lines.join("\n") });
  },

});
