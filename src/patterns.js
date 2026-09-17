/** Contextual OHLC formations. Strength is a heuristic, never a probability. */
const definitions = [
  ['doji','Doji','neutral',1,'Body at most 10% of range.'],
  ['long_legged_doji','Long-legged doji','neutral',1,'Doji with both shadows at least 35% of range.'],
  ['spinning_top','Spinning top','neutral',1,'Body 10–30% of range and both shadows at least 25%.'],
  ['high_wave','High-wave candle','neutral',1,'Body at most 20% and both shadows at least 35% of range.'],
  ['inside_bar','Inside bar','neutral',2,'Range contained within the previous range.'],
  ['outside_bar','Outside bar','neutral',2,'Range exceeds both ends of the previous range.'],
  ['bullish_marubozu','Bullish marubozu','bullish',1,'Bullish body at least 90% of range.'],
  ['bearish_marubozu','Bearish marubozu','bearish',1,'Bearish body at least 90% of range.'],
  ['hammer','Hammer','bullish',1,'After a decline: small upper body and lower shadow at least twice the body.'],
  ['hanging_man','Hanging man','bearish',1,'After a rise: small upper body and lower shadow at least twice the body.'],
  ['inverted_hammer','Inverted hammer','bullish',1,'After a decline: small lower body and upper shadow at least twice the body.'],
  ['shooting_star','Shooting star','bearish',1,'After a rise: small lower body and upper shadow at least twice the body.'],
  ['dragonfly_doji','Dragonfly doji','bullish',1,'After a decline: doji with lower shadow at least 70% of range.'],
  ['gravestone_doji','Gravestone doji','bearish',1,'After a rise: doji with upper shadow at least 70% of range.'],
  ['bullish_engulfing','Bullish engulfing','bullish',2,'After a decline: bullish body engulfs a bearish body and is at least 5% larger.'],
  ['bearish_engulfing','Bearish engulfing','bearish',2,'After a rise: bearish body engulfs a bullish body and is at least 5% larger.'],
  ['bullish_harami','Bullish harami','bullish',2,'After a decline: small bullish body within a long bearish body.'],
  ['bearish_harami','Bearish harami','bearish',2,'After a rise: small bearish body within a long bullish body.'],
  ['bullish_harami_cross','Bullish harami cross','bullish',2,'After a decline: doji body inside a long bearish body.'],
  ['bearish_harami_cross','Bearish harami cross','bearish',2,'After a rise: doji body inside a long bullish body.'],
  ['piercing_line','Piercing line','bullish',2,'After a decline: opens below prior close and closes above midpoint of prior long bearish body.'],
  ['dark_cloud_cover','Dark cloud cover','bearish',2,'After a rise: opens above prior close and closes below midpoint of prior long bullish body.'],
  ['tweezer_bottom','Tweezer bottom','bullish',2,'After a decline: bearish then bullish candles with lows within 5% of mean range.'],
  ['tweezer_top','Tweezer top','bearish',2,'After a rise: bullish then bearish candles with highs within 5% of mean range.'],
  ['morning_star','Morning star','bullish',3,'After a decline: long bearish, small body below it, then bullish close above first body midpoint.'],
  ['evening_star','Evening star','bearish',3,'After a rise: long bullish, small body above it, then bearish close below first body midpoint.'],
  ['morning_doji_star','Morning doji star','bullish',3,'Morning star whose middle candle is a doji.'],
  ['evening_doji_star','Evening doji star','bearish',3,'Evening star whose middle candle is a doji.'],
  ['three_white_soldiers','Three white soldiers','bullish',3,'After a decline: three rising strong bullish bodies opening inside prior bodies, with short upper shadows.'],
  ['three_black_crows','Three black crows','bearish',3,'After a rise: three falling strong bearish bodies opening inside prior bodies, with short lower shadows.'],
  ['three_inside_up','Three inside up','bullish',3,'Bullish harami followed by a bullish close above the first open.'],
  ['three_inside_down','Three inside down','bearish',3,'Bearish harami followed by a bearish close below the first open.'],
  ['three_outside_up','Three outside up','bullish',3,'Bullish engulfing followed by a higher bullish close.'],
  ['three_outside_down','Three outside down','bearish',3,'Bearish engulfing followed by a lower bearish close.'],
  ['rising_three_methods','Rising three methods','bullish',5,'In an uptrend: long bullish candle, three small contained candles, then bullish continuation above first close.'],
  ['falling_three_methods','Falling three methods','bearish',5,'In a downtrend: long bearish candle, three small contained candles, then bearish continuation below first close.'],
  ['bullish_kicker','Bullish kicker','bullish',2,'After a decline: long bearish then long bullish candle opening above prior open.'],
  ['bearish_kicker','Bearish kicker','bearish',2,'After a rise: long bullish then long bearish candle opening below prior open.'],
  ['bullish_belt_hold','Bullish belt hold','bullish',1,'After a decline: bullish body at least 70%, lower shadow at most 5%.'],
  ['bearish_belt_hold','Bearish belt hold','bearish',1,'After a rise: bearish body at least 70%, upper shadow at most 5%.'],
  ['bullish_abandoned_baby','Bullish abandoned baby','bullish',3,'After a decline: isolated doji below both neighbors, followed by a bullish midpoint recovery.'],
  ['bearish_abandoned_baby','Bearish abandoned baby','bearish',3,'After a rise: isolated doji above both neighbors, followed by a bearish midpoint reversal.'],
];
export const PATTERN_CATALOGUE = Object.freeze(definitions.map(([id,name,direction,bars,definition])=>Object.freeze({id,name,direction,bars,definition})));
const catalogue = new Map(PATTERN_CATALOGUE.map(row=>[row.id,row]));
const mean = values=>values.reduce((sum,value)=>sum+value,0)/values.length;
function geometry(bar) {
  if(!bar||![bar.open,bar.high,bar.low,bar.close].every(Number.isFinite)||bar.low<=0||bar.high<Math.max(bar.open,bar.close)||bar.low>Math.min(bar.open,bar.close))return null;
  const range=bar.high-bar.low,body=Math.abs(bar.close-bar.open),top=Math.max(bar.open,bar.close),bottom=Math.min(bar.open,bar.close);
  return {...bar,range,body,top,bottom,upper:bar.high-top,lower:bottom-bar.low,bull:bar.close>bar.open,bear:bar.close<bar.open,
    doji:range>0&&body<=range*.1,small:range>0&&body<=range*.3,long:range>0&&body>=range*.6};
}
export function detect_patterns(bars) {
  if(!Array.isArray(bars)||!bars.length)return [];
  const rows=bars.slice(-10).map(geometry);if(rows.some(row=>!row))return [];
  const result=[],last=rows.at(-1),previous=rows.at(-2),first=rows.at(-3);
  const context=span=>{
    const before=rows.slice(Math.max(0,rows.length-span-5),rows.length-span);
    if(before.length<3)return 'unknown';
    const move=before.at(-1).close-before[0].close,unit=mean(before.map(row=>row.range));
    return move>unit*.5?'uptrend':move<-unit*.5?'downtrend':'range';
  };
  const add=(id,test,strength=70,required=null)=>{
    if(!test)return;
    const definition=catalogue.get(id),trend=context(definition.bars);
    if(required&&trend!==required)return;
    result.push({...definition,context:trend,strength});
  };
  const engulfs=(a,b,bull)=>a&&b&&(bull?a.bear&&b.bull:a.bull&&b.bear)&&b.top>=a.top&&b.bottom<=a.bottom&&b.body>=a.body*1.05;
  const harami=(a,b,bull)=>a&&b&&a.long&&b.small&&(bull?a.bear&&b.bull:a.bull&&b.bear)&&b.top<a.top&&b.bottom>a.bottom;
  const hammer=last.range>0&&!last.doji&&last.body<=last.range*.35&&last.lower>=last.body*2&&last.upper<=last.range*.1;
  const inverted=last.range>0&&!last.doji&&last.body<=last.range*.35&&last.upper>=last.body*2&&last.lower<=last.range*.1;
  add('doji',last.doji,40);add('long_legged_doji',last.doji&&last.upper>=last.range*.35&&last.lower>=last.range*.35,50);
  add('spinning_top',last.small&&!last.doji&&last.upper>=last.range*.25&&last.lower>=last.range*.25,40);
  add('high_wave',last.range>0&&last.body<=last.range*.2&&last.upper>=last.range*.35&&last.lower>=last.range*.35,45);
  add('bullish_marubozu',last.bull&&last.body>=last.range*.9,70);add('bearish_marubozu',last.bear&&last.body>=last.range*.9,70);
  add('hammer',hammer,75,'downtrend');add('hanging_man',hammer,65,'uptrend');
  add('inverted_hammer',inverted,65,'downtrend');add('shooting_star',inverted,75,'uptrend');
  add('dragonfly_doji',last.doji&&last.lower>=last.range*.7&&last.upper<=last.range*.1,70,'downtrend');
  add('gravestone_doji',last.doji&&last.upper>=last.range*.7&&last.lower<=last.range*.1,70,'uptrend');
  add('bullish_belt_hold',last.bull&&last.body>=last.range*.7&&last.lower<=last.range*.05,70,'downtrend');
  add('bearish_belt_hold',last.bear&&last.body>=last.range*.7&&last.upper<=last.range*.05,70,'uptrend');
  if(previous){
    const tolerance=(previous.range+last.range)*.025;
    add('inside_bar',last.high<=previous.high&&last.low>=previous.low&&(last.high<previous.high||last.low>previous.low),45);
    add('outside_bar',last.high>previous.high&&last.low<previous.low,45);
    add('bullish_engulfing',engulfs(previous,last,true),85,'downtrend');add('bearish_engulfing',engulfs(previous,last,false),85,'uptrend');
    add('bullish_harami',harami(previous,last,true),65,'downtrend');add('bearish_harami',harami(previous,last,false),65,'uptrend');
    add('bullish_harami_cross',previous.long&&previous.bear&&last.doji&&last.top<previous.top&&last.bottom>previous.bottom,65,'downtrend');
    add('bearish_harami_cross',previous.long&&previous.bull&&last.doji&&last.top<previous.top&&last.bottom>previous.bottom,65,'uptrend');
    add('piercing_line',previous.bear&&previous.long&&last.bull&&last.open<previous.close&&last.close>(previous.open+previous.close)/2&&last.close<previous.open,80,'downtrend');
    add('dark_cloud_cover',previous.bull&&previous.long&&last.bear&&last.open>previous.close&&last.close<(previous.open+previous.close)/2&&last.close>previous.open,80,'uptrend');
    add('tweezer_bottom',previous.bear&&last.bull&&Math.abs(previous.low-last.low)<=tolerance,65,'downtrend');
    add('tweezer_top',previous.bull&&last.bear&&Math.abs(previous.high-last.high)<=tolerance,65,'uptrend');
    add('bullish_kicker',previous.bear&&previous.long&&last.bull&&last.long&&last.open>previous.open,90,'downtrend');
    add('bearish_kicker',previous.bull&&previous.long&&last.bear&&last.long&&last.open<previous.open,90,'uptrend');
  }
  if(first){
    const morning=first.bear&&first.long&&previous.small&&previous.top<first.close&&last.bull&&last.close>(first.open+first.close)/2;
    const evening=first.bull&&first.long&&previous.small&&previous.bottom>first.close&&last.bear&&last.close<(first.open+first.close)/2;
    add('morning_star',morning,85,'downtrend');add('evening_star',evening,85,'uptrend');
    add('morning_doji_star',morning&&previous.doji,90,'downtrend');add('evening_doji_star',evening&&previous.doji,90,'uptrend');
    const trio=[first,previous,last],insideOpen=(a,b)=>b.open>a.bottom&&b.open<a.top;
    add('three_white_soldiers',trio.every(row=>row.bull&&row.body>=row.range*.5&&row.upper<=row.range*.25)&&insideOpen(first,previous)&&insideOpen(previous,last)&&first.close<previous.close&&previous.close<last.close,85,'downtrend');
    add('three_black_crows',trio.every(row=>row.bear&&row.body>=row.range*.5&&row.lower<=row.range*.25)&&insideOpen(first,previous)&&insideOpen(previous,last)&&first.close>previous.close&&previous.close>last.close,85,'uptrend');
    add('three_inside_up',harami(first,previous,true)&&last.bull&&last.close>first.open,80,'downtrend');
    add('three_inside_down',harami(first,previous,false)&&last.bear&&last.close<first.open,80,'uptrend');
    add('three_outside_up',engulfs(first,previous,true)&&last.bull&&last.close>previous.close,90,'downtrend');
    add('three_outside_down',engulfs(first,previous,false)&&last.bear&&last.close<previous.close,90,'uptrend');
    add('bullish_abandoned_baby',first.bear&&first.long&&previous.doji&&previous.high<first.low&&last.low>previous.high&&last.bull&&last.close>(first.open+first.close)/2,95,'downtrend');
    add('bearish_abandoned_baby',first.bull&&first.long&&previous.doji&&previous.low>first.high&&last.high<previous.low&&last.bear&&last.close<(first.open+first.close)/2,95,'uptrend');
  }
  if(rows.length>=5){
    const start=rows.at(-5),middle=rows.slice(-4,-1),contained=middle.every(row=>row.small&&row.high<=start.high&&row.low>=start.low);
    add('rising_three_methods',start.bull&&start.long&&contained&&middle.some(row=>row.bear)&&last.bull&&last.long&&last.close>start.close,85,'uptrend');
    add('falling_three_methods',start.bear&&start.long&&contained&&middle.some(row=>row.bull)&&last.bear&&last.long&&last.close<start.close,85,'downtrend');
  }
  return result;
}
