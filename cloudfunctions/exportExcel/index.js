// exportExcel 云函数：根据报表生成 Excel（参考"费用明细表"格式）
const cloud = require("wx-server-sdk");
const xlsx = require("node-xlsx");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 行补齐到 7 格（node-xlsx 遇到长度不齐的行会崩）
function pad7(arr) {
  const a = arr.slice();
  while (a.length < 7) a.push("");
  return a;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { reportId } = event;

  if (!reportId) return { success: false, msg: "缺少 reportId" };

  try {
    const doc = await db.collection("reports").doc(reportId).get();
    const r = doc.data;
    if (!r) return { success: false, msg: "报表不存在" };
    if (r._openid !== OPENID && r.openid !== OPENID) {
      return { success: false, msg: "无权访问该报表" };
    }

    const round2 = (n) => Math.round(Number(n) * 100) / 100;
    const items = r.items || [];

    // 单元格样式
    const center = { alignment: { horizontal: "center", vertical: "center" } };
    const titleS = {
      alignment: { horizontal: "center", vertical: "center" },
      font: { bold: true, sz: 16 },
    };
    const headS = {
      alignment: { horizontal: "center", vertical: "center" },
      font: { bold: true },
    };
    const borderS = {
      border: {
        top: { style: "thin" },
        bottom: { style: "thin" },
        left: { style: "thin" },
        right: { style: "thin" },
      },
    };

    const merges = [];
    const data = [];
    let R = 0;

    // 标题行（合并 A:R:G）
    data.push(pad7([{ v: r.title || "报表", s: titleS }]));
    merges.push({ s: { r: R, c: 0 }, e: { r: R, c: 6 } });
    R++;

    // 客户 + 日期
    data.push(
      pad7([
        {
          v: "客户：" + r.customerName + "        日期：" + (r.date || ""),
          s: center,
        },
      ])
    );
    merges.push({ s: { r: R, c: 0 }, e: { r: R, c: 6 } });
    R++;

    // 位置（可选）：定位地点 + 具体门牌号
    const place = r.location && (r.location.address || r.location.name);
    const specific = r.address;
    const locParts = [];
    if (place) locParts.push(place);
    if (specific) locParts.push(specific);
    if (locParts.length) {
      data.push(pad7([{ v: "位置：" + locParts.join(" / "), s: center }]));
      merges.push({ s: { r: R, c: 0 }, e: { r: R, c: 6 } });
      R++;
    }

    // 空一行
    data.push(pad7([""]));
    R++;

    // 表头
    data.push(
      pad7(
        ["序号", "项目名称", "数量", "单位", "单价（元）", "金额（元）", "备注"].map(
          (h) => ({ v: h, s: Object.assign({}, headS, borderS) })
        )
      )
    );
    R++;

    // 数据行
    items.forEach((it, i) => {
      data.push([
        { v: i + 1, s: Object.assign({}, center, borderS) },
        {
          v: it.type === "goods" ? it.name : it.desc,
          s: Object.assign({}, borderS),
        },
        { v: it.type === "goods" ? it.quantity : "—", s: Object.assign({}, center, borderS) },
        { v: it.unit || "", s: Object.assign({}, center, borderS) },
        { v: it.type === "goods" ? round2(it.price) : "—", s: Object.assign({}, center, borderS) },
        { v: round2(it.amount), s: Object.assign({}, center, borderS) },
        { v: it.remark || "", s: Object.assign({}, borderS) },
      ]);
      R++;
    });

    // 合计行：合并 A:E 居中显示"总合计（元）"，金额在金额列
    data.push([
      {
        v: "总合计（元）",
        s: Object.assign({}, center, borderS),
      },
      "",
      "",
      "",
      "",
      { v: round2(r.totalAmount), s: Object.assign({}, center, borderS) },
      "",
    ]);
    merges.push({ s: { r: R, c: 0 }, e: { r: R, c: 4 } });
    R++;

    // 底部备注（可选，合并整行）
    if (r.remark) {
      data.push(
        pad7([
          { v: r.remark, s: { alignment: { horizontal: "left", wrapText: true } } },
        ])
      );
      merges.push({ s: { r: R, c: 0 }, e: { r: R, c: 6 } });
      R++;
    }

    // 服务说明（账户绑定，最后一行）
    if (r.serviceNote) {
      data.push(
        pad7([
          {
            v: r.serviceNote,
            s: { alignment: { horizontal: "left", wrapText: true } },
          },
        ])
      );
      merges.push({ s: { r: R, c: 0 }, e: { r: R, c: 6 } });
      R++;
    }

    const sheet = {
      name: "报表",
      data,
      options: {
        "!cols": [
          { wch: 6 },
          { wch: 32 },
          { wch: 8 },
          { wch: 8 },
          { wch: 12 },
          { wch: 12 },
          { wch: 20 },
        ],
        "!merges": merges,
      },
    };

    const buffer = xlsx.build([sheet]);

    const up = await cloud.uploadFile({
      cloudPath: `exports/report-${r._id}.xlsx`,
      fileContent: buffer,
    });

    return { success: true, fileID: up.fileID };
  } catch (e) {
    console.error("exportExcel error", e);
    return { success: false, msg: (e && e.message) || "导出失败" };
  }
};
