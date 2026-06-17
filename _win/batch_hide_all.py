# -*- coding: utf-8 -*-
"""批量生成全职业隐藏包(装备+武器)→ out/ + 部署进游戏 ImagePacks2。三九过夜任务。"""
import sys, os, time, shutil, subprocess, json
sys.path.insert(0, r'D:\dnf-reskin')
import make_hide_patch as mhp
CLI=mhp.DEFAULT_CLI
IP =r'E:\WeGameApps\地下城与勇士：创新世纪\ImagePacks2'
OUT=r'D:\dnf-reskin\afa-sprite-studio\out'; os.makedirs(OUT, exist_ok=True)
CLASSES=['imperialknight','thief','gunblader','knight','archer','demoniclancer','gunner','mage','fighter','priest','swordman']
results=[]
for cls in CLASSES:
    srcs=mhp.find_hide_sources(IP, cls)
    src_mb=round(sum(os.path.getsize(s) for s in srcs)/1048576) if srcs else 0
    out_npk=os.path.join(OUT, f'%27_{cls}_hide.NPK'); tmp=out_npk+'.tmp'
    if not srcs:
        results.append({'cls':cls,'zh':mhp.zh(cls),'status':'无源'}); print(f'[SKIP] {cls}: 无源'); continue
    if os.path.exists(tmp): os.remove(tmp)
    t=time.time()
    r=subprocess.run([CLI,'hide',tmp,*srcs],capture_output=True,text=True,encoding='utf-8',errors='replace')
    dt=round(time.time()-t,1)
    if r.returncode==0 and os.path.isfile(tmp):
        os.replace(tmp,out_npk); out_mb=round(os.path.getsize(out_npk)/1048576,1)
        shutil.copy2(out_npk, os.path.join(IP, f'%27_{cls}_hide.NPK'))
        lr=subprocess.run([CLI,'list',out_npk],capture_output=True,text=True,encoding='utf-8',errors='replace')
        nimg=sum(1 for l in (lr.stdout or '').splitlines() if l.startswith('IMG['))
        st='OK' if (lr.returncode==0 and nimg>0) else '验证异常'
        results.append({'cls':cls,'zh':mhp.zh(cls),'status':st,'srcs':len(srcs),'src_mb':src_mb,'out_mb':out_mb,'imgs':nimg,'sec':dt})
        print(f'[OK] {cls}({mhp.zh(cls)}): {len(srcs)}源/{src_mb}MB -> {out_mb}MB/{nimg}IMG {dt}s 已部署')
    else:
        if os.path.isfile(tmp): os.remove(tmp)
        results.append({'cls':cls,'zh':mhp.zh(cls),'status':'失败','err':(r.stderr or r.stdout or '')[-200:]})
        print(f'[FAIL] {cls}: rc={r.returncode}')
json.dump(results, open(os.path.join(OUT,'_hide_batch_result.json'),'w',encoding='utf-8'), ensure_ascii=False, indent=2)
ok=sum(1 for x in results if x.get('status')=='OK')
print('\n=== 完成 %d/%d, 部署隐藏包总计 %.0fMB ==='%(ok,len(CLASSES),sum(x.get('out_mb',0) for x in results)))
