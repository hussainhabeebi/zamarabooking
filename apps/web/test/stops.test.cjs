const test=require('node:test'),assert=require('node:assert/strict'),ts=require('typescript'),fs=require('node:fs'),Module=require('node:module'),path=require('node:path');
const load=(rel)=>{const file=path.resolve(__dirname,rel),m=new Module(file,module);m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,file);return m.exports;};
const {matchesStops,stopCount,stopsLabel,viaText}=load('../app/lib/stops.ts');
const direct={stops:0,stopDetails:[]},one={stops:1,stopDetails:[{airport:'BLR',layoverMinutes:160}]},two={stops:2,stopDetails:[{airport:'BLR',layoverMinutes:60},{airport:'HYD',layoverMinutes:95}]},unknown={stops:0,stopsUnknown:true,stopDetails:[]};
test('non-stop, 1 stop and 2+ stops filters',()=>{
  const all=[direct,one,two,unknown];
  assert.deepEqual(all.filter(f=>matchesStops(f,'0')),[direct]);
  assert.deepEqual(all.filter(f=>matchesStops(f,'1')),[one]);
  assert.deepEqual(all.filter(f=>matchesStops(f,'2')),[two]);
  assert.equal(all.filter(f=>matchesStops(f,null)).length,4);
});
test('unverified stop counts are never shown as non-stop',()=>{
  assert.equal(stopCount(unknown),null);assert.equal(stopsLabel(unknown),'Stops not confirmed');
  assert.equal(stopCount({stops:0,stopDetails:[{airport:'BLR'}]}),1);   // a listed connection is a stop
  assert.equal(stopCount({}),null);
});
test('via airport and layover text',()=>{
  assert.equal(viaText(one),'Via BLR (2h 40m layover)');
  assert.equal(viaText(two),'Via BLR (1h 00m layover) · HYD (1h 35m layover)');
  assert.equal(viaText(direct),'');
});
