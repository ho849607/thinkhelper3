import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
dotenv.config();
const app = express();
const port = process.env.PORT || 5500;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
app.get('/',(req,res)=>{res.sendFile(path.join(__dirname,'index.html'));});

app.post('/api/chat',async(req,res)=>{
  const{message,model='gemini',history=[]}=req.body;
  if(!message)return res.status(400).json({error:'message required'});
  try{
    if(model==='claude'){
      const KEY=process.env.CLAUDE_API_KEY;
      if(!KEY)throw new Error('CLAUDE_API_KEY not in .env');
      const messages=[...history.filter(m=>['user','assistant'].includes(m.role)).map(m=>({role:m.role,content:m.content})),{role:'user',content:message}];
      const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:process.env.CLAUDE_MODEL||'claude-sonnet-4-20250514',max_tokens:1024,system:'You are ThinkHelper AI. Answer in Korean.',messages})});
      if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error('Claude error('+r.status+'): '+e?.error?.message);}
      const d=await r.json();
      return res.json({text:d.content?.[0]?.text||''});
    }
    const KEY=process.env.GEMINI_API_KEY;
    if(!KEY)throw new Error('GEMINI_API_KEY not in .env');
    const mdl=process.env.GEMINI_MODEL||'gemini-2.0-flash';
    const url='https://generativelanguage.googleapis.com/v1beta/models/'+mdl+':generateContent?key='+KEY;
    const contents=[...history.filter(m=>['user','assistant'].includes(m.role)).map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]})),{role:'user',parts:[{text:message}]}];
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents,systemInstruction:{parts:[{text:'You are ThinkHelper AI. Answer in Korean.'}]},generationConfig:{temperature:0.7,maxOutputTokens:1024}})});
    if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error('Gemini error('+r.status+'): '+e?.error?.message);}
    const d=await r.json();
    return res.json({text:d.candidates?.[0]?.content?.parts?.[0]?.text||''});
  }catch(e){console.error('[/api/chat]',e?.message);return res.status(500).json({error:e?.message});}
});

app.post('/api/grok',async(req,res)=>{
  const{message,history=[]}=req.body;
  if(!message)return res.status(400).json({error:'message required'});
  try{
    const BASE=process.env.LMSTUDIO_BASE_URL||process.env.LM_STUDIO_BASE_URL||'http://127.0.0.1:1234';
    let MODEL=process.env.LMSTUDIO_MODEL||process.env.GROK_MODEL||'';
    if(!MODEL){
      try{
        const mr=await fetch(BASE+'/v1/models',{signal:AbortSignal.timeout(3000)});
        if(mr.ok){const md=await mr.json();MODEL=md.data?.[0]?.id||'';}
      }catch(e){console.warn('[LM Studio] detect failed:',e.message);}
    }
    if(!MODEL){MODEL='mistral-7b-grok';}
    console.log('[LM Studio] model:',MODEL);
    const messages=[{role:'system',content:'You are ThinkHelper AI. Answer in Korean.'},...history.filter(m=>['user','assistant'].includes(m.role)).map(m=>({role:m.role,content:m.content})),{role:'user',content:message}];
    const r=await fetch(BASE+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:MODEL,messages,temperature:0.7,max_tokens:1024,stream:false})});
    if(!r.ok){const t=await r.text().catch(()=>'');throw new Error('LM Studio error('+r.status+'): '+t);}
    const d=await r.json();
    return res.json({text:d.choices?.[0]?.message?.content||''});
  }catch(e){console.error('[/api/grok]',e?.message);return res.status(500).json({error:'LM Studio failed: '+e?.message});}
});

app.get('/api/search',async(req,res)=>{
  const query=req.query.q;
  if(!query)return res.status(400).json({error:'query required'});
  try{
    const GKEY=process.env.GEMINI_API_KEY;
    const SKEY=process.env.SERPER_API_KEY;
    let webResults=[];
    if(SKEY){
      try{
        const sr=await fetch('https://google.serper.dev/search',{method:'POST',headers:{'Content-Type':'application/json','X-API-KEY':SKEY},body:JSON.stringify({q:query,gl:'kr',hl:'ko',num:5})});
        if(sr.ok){const sd=await sr.json();webResults=(sd.organic||[]).map(r=>({title:r.title,link:r.link,snippet:r.snippet||''}));}
      }catch(e){console.warn('[search] Serper error:',e.message);}
    }
    let aiAnswer='';
    if(GKEY){
      const mdl=process.env.GEMINI_MODEL||'gemini-2.0-flash';
      const url='https://generativelanguage.googleapis.com/v1beta/models/'+mdl+':generateContent?key='+GKEY;
      const ctx=webResults.length>0?'Search results:\n'+webResults.map((r,i)=>(i+1)+'. '+r.title+'\n'+r.snippet).join('\n')+'\n\nQuestion: '+query:query;
      const sysPrompt='You are ThinkHelper search AI. Answer in Korean.\nFor flights ONLY respond:\n```json\n{"type":"flight_info","query":"route","summary":"s","best_price":"p","price_suggestion":"a","flights":[{"airline":"a","duration":"t","price":"p","booking_link":"https://www.skyscanner.co.kr"}]}\n```\nFor stocks ONLY respond:\n```json\n{"type":"stock_info","stock_name":"n","current_price":"p","change":"+0.00%","link":"https://finance.naver.com"}\n```';
      const gr=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:ctx}]}],systemInstruction:{parts:[{text:sysPrompt}]},generationConfig:{temperature:0.5,maxOutputTokens:1024}})});
      if(gr.ok){const gd=await gr.json();aiAnswer=gd.candidates?.[0]?.content?.parts?.[0]?.text||'';}
    }
    return res.json({answer:aiAnswer,results:webResults});
  }catch(e){console.error('[/api/search]',e?.message);return res.status(500).json({error:e?.message});}
});

app.get('/api/news',async(req,res)=>{
  const category=req.query.category||'AI tech news';
  try{
    const GKEY=process.env.GEMINI_API_KEY;
    const SKEY=process.env.SERPER_API_KEY;
    let articles=[];
    if(SKEY){
      const sr=await fetch('https://google.serper.dev/news',{method:'POST',headers:{'Content-Type':'application/json','X-API-KEY':SKEY},body:JSON.stringify({q:category,gl:'kr',hl:'ko',num:6})});
      if(sr.ok){const sd=await sr.json();articles=(sd.news||[]).map(r=>({title:r.title,link:r.link,source:r.source,date:r.date||'',imageUrl:r.imageUrl||''}));}
    }else if(GKEY){
      const mdl=process.env.GEMINI_MODEL||'gemini-2.0-flash';
      const url='https://generativelanguage.googleapis.com/v1beta/models/'+mdl+':generateContent?key='+GKEY;
      const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:category+' latest news 6 items, respond ONLY as JSON array: [{"title":"title","source":"source","date":"date","link":"#","imageUrl":""}]'}]}],generationConfig:{temperature:0.5,maxOutputTokens:1024}})});
      if(r.ok){
        const d=await r.json();
        const text=d.candidates?.[0]?.content?.parts?.[0]?.text||'[]';
        const match=text.match(/\[[\s\S]*\]/);
        if(match){try{articles=JSON.parse(match[0]);}catch{}}
      }
    }
    return res.json({articles});
  }catch(e){console.error('[/api/news]',e?.message);return res.status(500).json({error:e?.message});}
});

app.get('/api/status',(req,res)=>{
  res.json({status:'ok',gemini:!!process.env.GEMINI_API_KEY,claude:!!process.env.CLAUDE_API_KEY,lm_base:process.env.LMSTUDIO_BASE_URL||'http://127.0.0.1:1234',lm_model:process.env.LMSTUDIO_MODEL||process.env.GROK_MODEL||'auto'});
});

app.get(/.*/,(req,res)=>{res.sendFile(path.join(__dirname,'index.html'));});

app.listen(port,()=>{
  console.log('\n=== ThinkHelper Server ===');
  console.log('URL      : http://localhost:'+port);
  console.log('Gemini   : '+(process.env.GEMINI_API_KEY?'OK':'ERROR - set GEMINI_API_KEY in .env'));
  console.log('Claude   : '+(process.env.CLAUDE_API_KEY?'OK':'not set (optional)'));
  console.log('LM Studio: '+(process.env.LMSTUDIO_BASE_URL||'http://127.0.0.1:1234'));
  console.log('LM Model : '+(process.env.LMSTUDIO_MODEL||process.env.GROK_MODEL||'auto-detect'));
  console.log('=========================\n');
});
