// 时间相关的纯展示/纯计算小工具：偏移写法与两位补零，zones 与 convert 共用，避免互相 require
function offsetText(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hour = String(Math.floor(abs / 60)).padStart(2, '0');
  const minute = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hour}:${minute}`;
}

const pad = (num) => String(num).padStart(2, '0');

module.exports = { offsetText, pad };
