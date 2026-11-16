import { Compiler } from './src/compiler/compiler.js';
const set={version:'1',targetType:'web',targetName:'Heal Static',startUrl:'http://localhost:8080/',workflows:[{id:'11111111-1111-4111-8111-111111111111',label:'Remove item',steps:[{actionType:'click',selectors:['#remove'],anchor:{role:'button',name:'Remove',frame:[]},risk:'read',visual:{rect:{x:0.1,y:0.1,w:0.1,h:0.1},intent:'x'}}],variables:[],observedPayloads:[]}]};
await new Compiler().compile(set,'.static-probe',{healSupport:true});
