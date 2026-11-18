import ZXing from '@zxing/library';
// Pure matrix encoder: no DOM or remote QR service, and no personal data in the payload.
export function ticketQr(token: string) {
  if (!/^ntucc_ticket_[a-f0-9]{64}$/.test(token)) throw Error('Invalid ticket');
  const m = new ZXing.QRCodeWriter().encode(token, ZXing.BarcodeFormat.QR_CODE, 240, 240, new Map());
  let path = '';
  for (let y=0;y<m.getHeight();y++) for(let x=0;x<m.getWidth();x++) if(m.get(x,y)) path+=`M${x},${y}h1v1h-1z`;
  const qr_svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${m.getWidth()} ${m.getHeight()}"><rect width="100%" height="100%" fill="white"/><path d="${path}" fill="black"/></svg>`;
  return {qr_svg,qr_data_url:'data:image/svg+xml;base64,'+Buffer.from(qr_svg).toString('base64')};
}
