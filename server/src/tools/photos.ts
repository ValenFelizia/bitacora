import type { CheerioAPI } from 'cheerio';

export function selectPhotos($:CheerioAPI,base:URL) {
  const selected=new Map<string,{url:string;score:number}>();
  for(const el of $('img,[data-bg-image],[data-background],[style]').toArray()) {
    const item=$(el),attrs=el.attribs;
    if(item.closest('header,footer,nav,button').length || /logo|icon|button|spinner|favicon/i.test([attrs.class,attrs.id,attrs.alt].join(' '))) continue;
    const widths=(attrs['data-srcset']||attrs.srcset||item.closest('picture').find('source').first().attr('srcset')||'').split(',').map(s=>{
      const [url,size]=s.trim().split(/\s+/);return {url,score:parseFloat(size)||0};
    }).sort((a,b)=>b.score-a.score);
    const sources=[widths[0]?.url||attrs['data-src']||attrs.src,attrs['data-bg-image'],attrs['data-background'],...Array.from((attrs.style||'').matchAll(/url\(\s*["']?([^)'"\s]+)["']?\s*\)/gi),m=>m[1])];
    for(const source of sources.filter((s):s is string=>!!s)) {
      if(source.startsWith('#'))continue;
      try {
        const url=new URL(source,base);
        if(!['http:','https:'].includes(url.protocol) || /logo|favicon|spinner|button|icon/i.test(url.pathname)) continue;
        const w=Number(attrs.width); // Display size is only a ranking hint, never the file dimensions.
        const key=url.origin+url.pathname.replace(/-\d+x\d+(?=\.[^.]+$)/,'')+url.search;
        const score=(item.closest('main,article,[role="main"]').length?10000:0)+(/-\d+x\d+\./.test(url.pathname)?0:2000)+(widths[0]?.score||w||900);
        if(!selected.has(key)||selected.get(key)!.score<score) selected.set(key,{url:url.href,score});
      }catch{/* Malformed image addresses are not candidates. */}
    }
  }
  // Embedded CSS backgrounds are data too; no scripts or stylesheets are executed.
  for(const style of $('style').toArray()) for(const match of $(style).text().matchAll(/background(?:-image)?\s*:[^;}]*?url\(\s*["']?([^)'"\s]+)["']?\s*\)/gi)) {
    try {const url=new URL(match[1],base);if(['http:','https:'].includes(url.protocol)&& !/logo|icon|button|spinner/i.test(url.pathname) && !selected.has(url.href))selected.set(url.href,{url:url.href,score:500});}catch{}
  }
  return [...selected.values()].sort((a,b)=>b.score-a.score).map(p=>p.url);
}

export function photoDimensions(data:Buffer,ext:string):{width:number;height:number} {
  let width=0,height=0;
  if(ext==='png' && data.length>=24){width=data.readUInt32BE(16);height=data.readUInt32BE(20);}
  if(ext==='jpg') {
    let p=2;
    while(p+4<data.length) {
      if(data[p++]!==255) continue;
      while(data[p]===255)p++;
      const marker=data[p++];if(marker===0xda||marker===0xd9)break;
      if(marker===1||(marker>=0xd0&&marker<=0xd8))continue;
      if(p+2>data.length)break;
      const size=data.readUInt16BE(p);if(size<2||p+size>data.length)break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&size>=7){height=data.readUInt16BE(p+3);width=data.readUInt16BE(p+5);break;}
      p+=size;
    }
  }
  if(ext==='webp') for(let p=12;p+8<data.length;) {
    const type=data.toString('ascii',p,p+4),size=data.readUInt32LE(p+4),v=p+8;if(v+size>data.length)break;
    if(type==='VP8X'&&size>=10){width=data.readUIntLE(v+4,3)+1;height=data.readUIntLE(v+7,3)+1;break;}
    if(type==='VP8L'&&size>=5&&data[v]===0x2f){const bits=data.readUInt32LE(v+1);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;break;}
    if(type==='VP8 '&&size>=10&&data.subarray(v+3,v+6).equals(Buffer.from([0x9d,1,0x2a]))){width=data.readUInt16LE(v+6)&0x3fff;height=data.readUInt16LE(v+8)&0x3fff;break;}
    p=v+size+(size%2);
  }
  if(!width||!height)throw new Error('No pude leer las dimensiones de la foto.');
  return {width,height};
}
