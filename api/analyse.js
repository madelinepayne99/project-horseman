const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const num=v=>{const x=parseFloat(v);return Number.isFinite(x)?x:null};
const dir=s=>s>=2?'BULLISH':s<=-2?'BEARISH':'NEUTRAL';
const words={pos:['beat','growth','record','strong','surge','gain','upgrade','profit','rally','raises','outperform'],neg:['miss','weak','drop','fall','cut','downgrade','loss','lawsuit','probe','risk','warning','decline','recall']};
function tone(t=''){const s=t.toLowerCase();let z=0;for(const w of words.pos)if(s.includes(w))z++;for(const w of words.neg)if(s.includes(w))z--;return z}
function sma(a,k){return a.length>=k?avg(a.slice(-k)):null}
function rsi(a,k=14){if(a.length<k+1)return null;let g=0,l=0;for(let i=a.length-k;i<a.length;i++){const d=a[i]-a[i-1];if(d>0)g+=d;else l-=d}if(!l)return 100;const rs=(g/k)/(l/k);return 100-100/(1+rs)}
function stdev(a){if(a.length<2)return 0;const m=avg(a);return Math.sqrt(avg(a.map(x=>(x-m)**2)))}
function pctChanges(a,n=20){const out=[];for(let i=Math.max(1,a.length-n);i<a.length;i++)out.push((a[i]/a[i-1]-1)*100);return out}
async function fetchJson(url){const c=new AbortController(),id=setTimeout(()=>c.abort(),8000);try{const r=await fetch(url,{signal:c.signal,headers:{'Accept':'application/json'},cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);return await r.json()}finally{clearTimeout(id)}}
async function alpha(fn,t){const key=String(process.env.ALPHA_VANTAGE_API_KEY||'').trim();if(!key)throw new Error('Alpha Vantage key not configured');const d=await fetchJson(`https://www.alphavantage.co/query?function=${fn}&symbol=${encodeURIComponent(t)}&apikey=${encodeURIComponent(key)}`);if(d.Note||d.Information||d['Error Message'])throw new Error(d.Note||d.Information||d['Error Message']);return d}
function ctype(s=''){s=s.toLowerCase();if(/rumou?r|reportedly|unconfirmed|speculation/.test(s))return'RUMOUR';if(/forecast|expects?|could|may |might|target|outlook|predict/.test(s))return'PREDICTION';if(/why |should |buy |sell |undervalued|overvalued|opinion/.test(s))return'OPINION';return'REPORTED CLAIM'}
function evidence(claim,type,source,reliability,supports='NEUTRAL',published=null,note=''){return{claim,type,source,reliability,reliabilityScore:{'VERY HIGH':90,HIGH:78,MEDIUM:60,LOW:38}[reliability]||50,supports,published,freshness:published?new Date(published).toLocaleDateString('en-GB'):'Not dated',confirmed:false,confirmation:'Not independently confirmed on this run.',possibleBias:note||'Check the original source for context.'}}
module.exports=async function(req,res){
 try{
  const ticker=String(req.query?.ticker||'').trim().toUpperCase().replace(/[^A-Z0-9.\-]/g,'').slice(0,12);if(!ticker)return res.status(400).json({error:'Enter a ticker first.'});
  const chartP=fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`);
  const newsP=fetchJson(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=1&newsCount=10`).catch(()=>({news:[]}));
  const overviewP=alpha('OVERVIEW',ticker).catch(e=>({__error:e.message}));
  const earningsP=alpha('EARNINGS',ticker).catch(e=>({__error:e.message}));
  const [chart,newsRaw,overview,earnings]=await Promise.all([chartP,newsP,overviewP,earningsP]);
  const cr=chart?.chart?.result?.[0];if(!cr)return res.status(404).json({error:'Ticker not found or market data unavailable.'});
  const q=cr.indicators?.quote?.[0]||{},closes=(q.close||[]).filter(Number.isFinite),vols=(q.volume||[]).filter(Number.isFinite);if(closes.length<50)return res.status(502).json({error:'Not enough price history returned.'});
  const last=closes.at(-1),s20=sma(closes,20),s50=sma(closes,50),s200=sma(closes,200),r14=rsi(closes),ret20=(last/closes.at(-21)-1)*100,vr=vols.length>21?vols.at(-1)/avg(vols.slice(-21,-1)):null;
  const ch20=pctChanges(closes,20),realizedVol=stdev(ch20),absMoveAvg=avg(ch20.map(Math.abs)),lastMove=closes.length>1?(last/closes.at(-2)-1)*100:0;
  let ws=0,we=[];for(const [label,v] of [['20-day',s20],['50-day',s50],['200-day',s200]])if(v){ws+=last>v?1:-1;we.push(`Price ${last>v?'above':'below'} ${label} average (${v.toFixed(2)})`)}ws+=ret20>3?1:ret20<-3?-1:0;we.push(`20-session change ${ret20.toFixed(1)}%`);if(r14){ws+=r14>70?-1:r14<30?1:0;we.push(`RSI ${r14.toFixed(1)}`)}if(vr)we.push(`Latest volume ${vr.toFixed(2)}Ã— recent average`);
  // --- WAR ENGINE V2 (opt-in via ?warEngine=v2) -------------------------
  // Rebuilds War's FACTS from the validated Twelve Data pipeline while
  // reusing the EXACT scoring rules above, so a side-by-side comparison
  // isolates the data source as the only variable. War's reasoning is
  // deliberately not redesigned here. Default remains v1 until approved.
  // Only War is affected: Conquest still uses Yahoo's volume ratio (vr)
  // and Death still uses Yahoo's r14/ret20 â€” both intentionally untouched.
  let warMeta=null,warLimits=['Yahoo market data can be delayed.'],warConfidenceOverride=null;
  // M2: the authoritative technical facts object from the V2 pipeline.
  // Death consumes THIS (shared facts), never War's evidence strings, so
  // War interprets and Death cross-examines the same underlying numbers.
  let warFactsV2=null,warV2Requested=false;
  if(String(req.query?.warEngine||'').trim().toLowerCase()==='v2'){
    warV2Requested=true;
    try{
      const [{buildWarInput},{getProvider}]=await Promise.all([
        import('../src/technicals/buildWarInput.js'),
        import('../src/getProvider.js')
      ]);
      const series=await getProvider().getDailySeries(ticker);
      const w=buildWarInput(series);
      if(w.dataStatus==='UNSUPPORTED_SECURITY'||w.dataStatus==='INSUFFICIENT_EVIDENCE')throw new Error(w.dataStatus);
      warFactsV2=w;
      ws=0;we=[];
      const ma=w.movingAverages||{};
      for(const [label,v] of [['20-day',ma.ma20],['50-day',ma.ma50],['200-day',ma.ma200]])
        if(v!=null){ws+=w.latestPrice>v?1:-1;we.push(`Price ${w.latestPrice>v?'above':'below'} ${label} average (${v.toFixed(2)})`)}
      const r20=w.percentChange?.twentyDay;
      if(r20!=null){ws+=r20>3?1:r20<-3?-1:0;we.push(`20-session change ${r20.toFixed(1)}%`)}
      if(w.rsi14!=null){ws+=w.rsi14>70?-1:w.rsi14<30?1:0;we.push(`RSI ${w.rsi14.toFixed(1)}`)}
      // Volume stays UNSCORED (as in v1) and is omitted entirely when the
      // bar is still forming, per the provisional-bar policy.
      if(w.volume?.vsAveragePct!=null)we.push(`Latest volume ${(1+w.volume.vsAveragePct/100).toFixed(2)}Ã— recent average`);
      warMeta={engine:'v2',provider:w.source?.provider||null,simulated:w.source?.simulated??null,dataStatus:w.dataStatus,latestDataTimestamp:w.latestDataTimestamp||null,latestBarIsProvisional:w.latestBarIsProvisional??null,candlesUsed:w.dataPointsUsed??null,calculationVersion:w.debug?.calculationVersion||null};
      warLimits=[`Technical evidence from ${w.source?.provider||'provider'} (War engine v2).`];
      if(w.latestBarIsProvisional)warLimits.push('Latest bar is still forming â€” volume comparison withheld until the session settles.');
      if(w.dataStatus!=='COMPLETE')warLimits.push(`Data status: ${w.dataStatus}.`);
    }catch(err){
      // Honest degradation: no silent fallback to the v1/Yahoo numbers.
      // warFactsV2 stays null, so Death's M2 wiring below treats its
      // authoritative technical inputs as missing rather than reverting
      // to the legacy Yahoo values that are still in scope.
      warFactsV2=null;
      ws=0;we=['Technical data unavailable from the primary provider on this run.'];
      warConfidenceOverride=50;
      warMeta={engine:'v2',provider:'twelvedata',dataStatus:'DATA_UNAVAILABLE',error:String(err&&err.code||err&&err.message||'UNKNOWN')};
      warLimits=['War could not obtain technical evidence on this run; Council is judging without it.'];
    }
  }
  const news=(newsRaw.news||[]).slice(0,10).map(x=>({title:x.title||'',source:x.publisher||'News',url:x.link||'',published:x.providerPublishTime?new Date(x.providerPublishTime*1000).toISOString():null,tone:tone(x.title||'')})).filter(x=>x.title);
  let fs=0,fe=[],fl=[];const ev=[];const ovOK=overview&&!overview.__error&&overview.Symbol;
  if(ovOK){const rg=num(overview.QuarterlyRevenueGrowthYOY),eg=num(overview.QuarterlyEarningsGrowthYOY),pm=num(overview.ProfitMargin),pe=num(overview.PERatio),eps=num(overview.EPS);if(rg!=null){fs+=rg>.05?1:rg<0?-1:0;fe.push(`Revenue growth ${(rg*100).toFixed(1)}% YoY`);ev.push(evidence(`Quarterly revenue growth was ${(rg*100).toFixed(1)}% year-on-year`,'FACT','Alpha Vantage structured fundamentals','HIGH',rg>.05?'BULLISH':rg<0?'BEARISH':'NEUTRAL',overview.LatestQuarter,'Structured vendor data derived from company reporting.'))}if(eg!=null){fs+=eg>.05?1:eg<0?-1:0;fe.push(`Earnings growth ${(eg*100).toFixed(1)}% YoY`);ev.push(evidence(`Quarterly earnings growth was ${(eg*100).toFixed(1)}% year-on-year`,'FACT','Alpha Vantage structured fundamentals','HIGH',eg>.05?'BULLISH':eg<0?'BEARISH':'NEUTRAL',overview.LatestQuarter))}if(pm!=null)fe.push(`Profit margin ${(pm*100).toFixed(1)}%`);if(eps!=null)fe.push(`EPS ${eps}`);if(pe!=null)fe.push(`P/E ${pe}`)}else fl.push('Structured fundamentals unavailable: '+(overview?.__error||'no data'));
  if(earnings&&!earnings.__error&&earnings.quarterlyEarnings?.[0]){const e=earnings.quarterlyEarnings[0],sp=num(e.surprisePercentage);if(sp!=null){fs+=sp>3?1:sp<-3?-1:0;fe.push(`Latest EPS surprise ${sp.toFixed(1)}%`);ev.push(evidence(`Latest EPS surprise was ${sp.toFixed(1)}%`,'FACT','Alpha Vantage earnings history','HIGH',sp>3?'BULLISH':sp<-3?'BEARISH':'NEUTRAL',e.fiscalDateEnding))}}else fl.push('Detailed earnings history unavailable on this run.');
  const nt=news.reduce((a,x)=>a+x.tone,0);if(news.length){fs+=nt>=3?1:nt<=-3?-1:0;fe.push(`${news.length} recent news headlines checked`)}else fl.push('No recent news headlines returned.');
  news.forEach(x=>ev.push(evidence(x.title,ctype(x.title),x.source,ctype(x.title)==='RUMOUR'?'LOW':'MEDIUM',x.tone>0?'BULLISH':x.tone<0?'BEARISH':'NEUTRAL',x.published,'Headline-level evidence can omit context.')));
  ev.push(evidence(`Latest observed market price ${last.toFixed(2)} ${cr.meta?.currency||''}`,'FACT','Yahoo Finance chart data','HIGH','NEUTRAL',new Date().toISOString(),'Market data may be delayed.'));
  const now=Date.now(),news24=news.filter(x=>x.published&&now-new Date(x.published).getTime()<=86400000).length,news72=news.filter(x=>x.published&&now-new Date(x.published).getTime()<=259200000).length;
  const publisherCounts={};for(const x of news)publisherCounts[x.source]=(publisherCounts[x.source]||0)+1;const dominantPublisher=news.length?Math.max(...Object.values(publisherCounts))/news.length:0;
  const positiveHeads=news.filter(x=>x.tone>0).length,negativeHeads=news.filter(x=>x.tone<0).length,toneSplit=positiveHeads>0&&negativeHeads>0;
  let attention=0,crowding=0;
  // --- M3: Conquest's one-day move input --------------------------------
  // V1 (default): unchanged â€” the legacy Yahoo-derived lastMove.
  // V2: the authoritative percentChange.oneDay from the shared facts
  // object (not War's output or evidence text), so Conquest and War cannot
  // describe the same session's move differently. No fallback to lastMove
  // if the authoritative value is missing â€” it is treated as unavailable.
  // Scope note: absMoveAvg (the baseline it is compared against), vr,
  // realizedVol, crowding and news logic are deliberately untouched here.
  let conquestLastMove=lastMove,conquestMoveMissing=false;
  // Crowding's technical inputs follow the same rule: authoritative under
  // V2, legacy Yahoo under V1, never a silent mix. Thresholds unchanged.
  let conquestRsi=r14,conquestRet20=ret20,conquestCrowdMissing=false;
  if(warV2Requested){
    conquestLastMove=warFactsV2&&warFactsV2.percentChange&&warFactsV2.percentChange.oneDay!=null?warFactsV2.percentChange.oneDay:null;
    conquestMoveMissing=(conquestLastMove==null);
    conquestRsi=warFactsV2&&warFactsV2.rsi14!=null?warFactsV2.rsi14:null;
    conquestRet20=warFactsV2&&warFactsV2.percentChange&&warFactsV2.percentChange.twentyDay!=null?warFactsV2.percentChange.twentyDay:null;
    conquestCrowdMissing=(conquestRsi==null||conquestRet20==null);
  }
  if(news24>=4)attention+=2;else if(news72>=5)attention+=1;
  if(vr!=null){if(vr>=2)attention+=2;else if(vr>=1.35)attention+=1}
  if(realizedVol>=3)attention+=1;
  if(conquestLastMove!=null&&Math.abs(conquestLastMove)>=Math.max(3,absMoveAvg*2.2))attention+=1;
  if((conquestRsi!=null&&(conquestRsi>=75||conquestRsi<=25)))crowding+=1;
  if(conquestRet20!=null&&Math.abs(conquestRet20)>=15)crowding+=1;
  if(vr!=null&&vr>=2)crowding+=1;
  if(news.length>=6&&dominantPublisher>=0.6)crowding+=1;
  let cs=nt>=4?2:nt<=-4?-2:nt>0?1:nt<0?-1:0;
  if(toneSplit&&Math.abs(nt)<=2)cs=0;
  const attentionLabel=attention>=4?'VERY HIGH':attention>=2?'ELEVATED':'NORMAL';
  const crowdLabel=crowding>=3?'HIGH':crowding>=1?'ELEVATED':'LOW';
  const conquestLimits=['Trading activity can reveal attention, but it cannot tell Horseman exactly why people are trading.','News volume is an attention proxy, not a direct survey of investor sentiment.'];
  if(conquestMoveMissing)conquestLimits.push('Authoritative one-day price move unavailable on this run; the short-term move signal was not applied.');
  if(conquestCrowdMissing)conquestLimits.push('Authoritative RSI / 20-session change unavailable on this run; the related crowding signals were not applied.');
  const ce=[
    `News attention: ${attentionLabel} (${news24} headline(s) in 24h; ${news72} in 72h)`,
    `Headline mood: ${nt>0?'more positive':nt<0?'more negative':'mixed/neutral'} (${positiveHeads} positive / ${negativeHeads} negative)`,
    `Trading attention: ${vr!=null?`${vr.toFixed(2)}Ã— normal volume`:'volume comparison unavailable'}`,
    `Recent volatility: ${realizedVol.toFixed(2)}% daily-move standard deviation`,
    `Crowding risk: ${crowdLabel}`,
    toneSplit?'Bullish and bearish headlines are both present â€” crowd opinion is split.':'No strong two-sided headline split detected.'
  ];
  ev.push(evidence(`Conquest observed ${attentionLabel.toLowerCase()} attention using news recency, trading volume and recent volatility`,'FACT','Horseman crowd-attention model','MEDIUM','NEUTRAL',new Date().toISOString(),'This is a derived attention signal, not proof of investor intent.'));
  if(vr!=null)ev.push(evidence(`Latest trading volume was ${vr.toFixed(2)}Ã— its recent average`,'FACT','Yahoo Finance chart data','HIGH','NEUTRAL',new Date().toISOString(),'Unusual volume can reflect many causes; Conquest uses it only as an attention signal.'));
  const war={icon:'âš”ï¸',name:'WAR',label:'PRICE & CHART',simple:'Is the share price looking strong or weak?',direction:dir(ws),confidence:clamp(55+Math.abs(ws)*7,50,90),checked:['1 year price history','20/50/200-day averages','RSI','momentum','volume'],evidence:we,limits:warLimits};
  if(warConfidenceOverride!=null)war.confidence=warConfidenceOverride;
  if(warMeta)war.dataSource=warMeta;
  const famine={icon:'ðŸ¥€',name:'FAMINE',label:'COMPANY & NEWS',simple:'Are the company numbers and current news helping or hurting it?',direction:dir(fs),confidence:clamp(48+Math.abs(fs)*7+(ovOK?8:0),42,90),checked:['Alpha Vantage fundamentals','earnings history','recent news'],evidence:fe.length?fe:['No fundamental evidence returned.'],limits:fl.length?fl:['Fundamentals are historical evidence, not a forecast.']};
  const conquest={icon:'ðŸ‘‘',name:'CONQUEST',label:'PEOPLE & HYPE',simple:'Is attention around the stock calm, fearful, excited or crowded?',direction:dir(cs),confidence:clamp(48+Math.min(attention,5)*5+Math.min(news.length,8)+Math.abs(nt)*2-(toneSplit?5:0),42,84),checked:['news-attention acceleration','headline mood and disagreement','unusual trading volume','recent volatility','large short-term moves','crowding indicators'],evidence:ce,limits:conquestLimits,signals:{attention:attentionLabel,crowding:crowdLabel,news24,news72,volumeRatio:vr,realizedVolatility:realizedVol,headlineBalance:{positive:positiveHeads,negative:negativeHeads,split:toneSplit}}};
  const dirs=[war.direction,famine.direction,conquest.direction],bull=dirs.filter(x=>x==='BULLISH').length,bear=dirs.filter(x=>x==='BEARISH').length,neutral=3-bull-bear,disagree=bull>0&&bear>0;
  // --- M2: Death's technical inputs -------------------------------------
  // V1 (default): unchanged â€” Death reads the legacy Yahoo-derived values.
  // V2: Death reads the SAME authoritative facts War interpreted, so the
  // two can never cite different RSI values for the same stock. There is
  // deliberately no fallback to r14/ret20 here: if the authoritative facts
  // are missing, they are treated as missing rather than substituted.
  // Thresholds are NOT recalibrated in this task (>75 / >15 unchanged).
  let deathRsi=r14,deathRet20=ret20,deathTechMissing=false;
  if(warV2Requested){
    deathRsi=warFactsV2&&warFactsV2.rsi14!=null?warFactsV2.rsi14:null;
    deathRet20=warFactsV2&&warFactsV2.percentChange&&warFactsV2.percentChange.twentyDay!=null?warFactsV2.percentChange.twentyDay:null;
    deathTechMissing=(deathRsi==null||deathRet20==null);
  }
  let risk=0,de=[];if(deathRsi!=null&&deathRsi>75){risk++;de.push('RSI is very high')}if(deathRet20!=null&&Math.abs(deathRet20)>15){risk++;de.push('Large recent price move')}if(deathTechMissing){risk++;de.push('Authoritative technical evidence unavailable')}if(disagree){risk+=2;de.push('Horsemen directly disagree')}if(!ovOK){risk++;de.push('Structured fundamentals unavailable')}if(crowding>=3){risk+=2;de.push('Conquest detected high crowding risk')}else if(crowding>=1){risk++;de.push('Conquest detected elevated crowding risk')};
  const death={icon:'â˜ ï¸',name:'DEATH',label:'DANGER',simple:'What could go wrong, and is waiting safer?',direction:risk>=4?'BEARISH':risk>=2?'NEUTRAL':'BULLISH',confidence:clamp(58+risk*6,55,88),checked:['stretched price','large recent moves','missing data','Horseman disagreement','Conquest crowding signals'],evidence:de.length?de:['No major connected-data risk flag triggered.'],limits:['Unknown events can still occur.']};
  let councilConfidence=Math.round(avg([war.confidence,famine.confidence,conquest.confidence])-neutral*8-(disagree?20:0)-risk*4);councilConfidence=clamp(councilConfidence,25,92);
  let verdict='WATCH';if(bear>=2)verdict='REJECT';else if(!disagree&&bull===3&&risk<3)verdict=councilConfidence>=84?'STRONG':'FAVOURABLE';else if(!disagree&&bull>=2&&risk<4&&councilConfidence>=60)verdict='FAVOURABLE';
  const conflict=ev.some(x=>x.supports==='BULLISH')&&ev.some(x=>x.supports==='BEARISH');if(conflict)councilConfidence=clamp(councilConfidence-8,25,92);const high=ev.filter(x=>x.reliabilityScore>=72).length,rum=ev.filter(x=>x.type==='RUMOUR').length;
  const evidenceEngine={rule:'Rank the evidence, not the website.',summary:`${ev.length} evidence items assessed Â· ${high} high-reliability Â· ${rum} rumour(s).`,conflict,conflictNote:conflict?'Positive and negative evidence both exist, so Council confidence is reduced.':'No direct positive-vs-negative conflict detected in the captured evidence.',items:ev.sort((a,b)=>b.reliabilityScore-a.reliabilityScore)};
  const name=ovOK?overview.Name:(cr.meta?.shortName||ticker);
  return res.status(200).json({retrievedAt:new Date().toISOString(),asset:{ticker,name,currency:cr.meta?.currency,price:last},sources:{market:'Yahoo Finance chart data',fundamentals:'Alpha Vantage',news:'Yahoo Finance news search',sentiment:'Horseman multi-signal Conquest model (news attention + trading activity)',newsItems:news},evidenceEngine,horsemen:[war,famine,conquest,death],council:{verdict,confidence:councilConfidence,synopsis:`${name}: ${verdict}. The Council combined price behaviour, available fundamentals, multi-signal crowd attention and Death's risk checks.`,reasons:[`War: ${war.direction}; Famine: ${famine.direction}; Conquest: ${conquest.direction}.`,disagree?'Direct disagreement reduced confidence.':'No direct bullish-vs-bearish split among the primary Horsemen.',risk?`Death raised ${risk} risk point(s).`:'Death found no major connected-data risk flag.'],changeMind:['New price action, company results, verified news, or a material new risk can change the verdict.']}})
 }catch(e){console.error(e);return res.status(500).json({error:'Live analysis failed: '+(e?.message||'unknown error')})}
}
