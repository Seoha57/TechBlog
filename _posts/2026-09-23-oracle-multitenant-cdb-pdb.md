---
layout: post
title: "Oracle Multitenant를 이해하는 법: CDB·PDB·서비스·복제와 운영 경계"
date: 2026-09-23 14:00:00 +0900
categories: [dba]
tags: [dba, oracle, oracle-database, multitenant, cdb, pdb, database-consolidation]
description: "Oracle Database Multitenant의 CDB·PDB 구조를 처음 접하는 사람을 위해 컨테이너 경계, 서비스 연결, 복제·이동, 권한과 운영 기준을 설명합니다."
---

Oracle Database의 Multitenant Architecture를 처음 들으면 “테넌트가 여러 개인 SaaS용 기능인가?”라고 생각하기 쉽습니다. 실제로는 그보다 넓은 데이터베이스 운영 구조입니다. 여러 독립 데이터베이스를 각각 인스턴스와 파일 집합으로 운영하던 방식을, 하나의 CDB(Container Database) 안에 여러 PDB(Pluggable Database)를 두는 형태로 정리할 수 있게 합니다. 개발·테스트·업무 시스템을 PDB 단위로 분리하면서도 패치, 백업, 리소스, 모니터링의 공통 부분을 함께 관리하려는 접근입니다.

PDB는 애플리케이션 관점에서 별도 Oracle 데이터베이스처럼 보일 수 있습니다. 그러나 물리적으로 완전히 아무것도 공유하지 않는 독립 서버와 같다는 뜻은 아닙니다. CDB의 instance, control file, redo log, 일부 공통 메타데이터와 운영 경계를 공유합니다. 그래서 관리 효율을 얻는 대신, root의 설정·장애·권한·용량 계획이 여러 PDB에 영향을 줄 수 있다는 사실을 함께 이해해야 합니다.

이 글은 Oracle 공식 Multitenant Administrator's Guide를 바탕으로 CDB와 PDB의 역할, 서비스 연결, clone·unplug·plug 같은 이동 방식, 그리고 도입 판단 기준을 정리합니다. 특정 Oracle 환경을 직접 운영한 결과는 주장하지 않습니다. Oracle edition·서비스·버전에 따라 가능한 기능과 라이선스 조건이 달라질 수 있으므로, 실제 도입 전에는 사용 중인 버전의 Licensing Information User Manual과 계약 조건을 반드시 확인해야 합니다.

<section class="quick-answers">
  <p class="quick-label">먼저 답하면</p>
  <div class="quick-answer"><h3>Q. PDB 하나는 완전히 독립된 DB 서버인가요?</h3><p>A. 애플리케이션에는 분리된 데이터베이스처럼 보이지만 CDB의 instance와 일부 공통 구조를 공유합니다. 따라서 root 설정·패치·호스트 장애의 영향을 전혀 받지 않는 완전한 물리 격리는 아닙니다.</p></div>
  <div class="quick-answer"><h3>Q. Multitenant면 고객별 SaaS tenant를 무조건 PDB로 나눠야 하나요?</h3><p>A. 아닙니다. PDB는 강한 관리 경계가 필요할 때 유용하지만, tenant 수·비용·운영 자동화·데이터 격리 요구를 봐야 합니다. 작은 tenant를 전부 PDB로 만들기보다 애플리케이션의 row-level tenancy가 나을 수 있습니다.</p></div>
  <div class="quick-answer"><h3>Q. PDB를 clone하면 운영 데이터 복제가 안전한가요?</h3><p>A. clone은 개발·테스트에 유용할 수 있지만 개인정보·TDE keystore·접속 정보·저장 공간·원본 PDB 상태를 함께 검토해야 합니다. clone 자체가 비식별화나 접근 통제를 대신하지는 않습니다.</p></div>
</section>

<figure class="article-figure">
  <img src="{{ '/assets/images/oracle-multitenant-cdb-pdb.svg' | relative_url }}" alt="하나의 Oracle CDB 안에 CDB root와 PDB seed, 여러 PDB가 있고 애플리케이션은 PDB 서비스로 연결되는 구조">
  <figcaption>이미지 출처: Oracle Multitenant Architecture 문서를 바탕으로 직접 제작</figcaption>
</figure>

## 먼저 알아둘 기반 기술: 인스턴스, 데이터베이스, 스키마, 서비스

데이터베이스 용어가 섞이면 CDB와 PDB도 쉽게 오해합니다. **Oracle instance** 는 메모리 영역과 background process가 데이터베이스 파일을 관리하는 실행 단위입니다. **database** 는 control file, data file, online redo log 같은 물리 파일의 집합과 논리 구조를 포함합니다. 단순화하면 instance는 실행 중인 엔진에, database는 엔진이 관리하는 데이터와 파일에 가깝습니다. 실제 HA 구성에서는 관계가 더 복잡해질 수 있지만, PDB가 독립 instance 하나를 의미하지 않는다는 점을 먼저 기억하면 됩니다.

**스키마(schema)** 는 한 database 안에서 사용자와 객체를 묶는 논리 이름 공간입니다. `HR.EMPLOYEES`처럼 table과 view, procedure는 schema에 속합니다. 반면 PDB는 schema 여러 개와 data dictionary, tablespace, 관련 객체를 포함해 애플리케이션에는 별도 database처럼 보이는 더 큰 단위입니다. 따라서 schema를 나누는 것과 PDB를 나누는 것은 격리 수준·백업 복구·패치·이동성에서 다른 선택입니다.

**서비스(service)** 는 클라이언트가 어떤 database 또는 PDB에 접속할지를 나타내는 논리 연결 이름입니다. JDBC, SQL*Plus, 애플리케이션 connection string은 보통 host와 port뿐 아니라 service name을 통해 대상 PDB를 선택합니다. CDB가 있다고 해서 모든 애플리케이션이 root에 접속하는 것은 아닙니다. 업무 애플리케이션은 원칙적으로 자신이 사용할 PDB의 서비스로 연결해야 하며, root는 CDB 전체 관리 목적의 특별한 경계입니다.

**database consolidation(통합)** 은 여러 DB를 무조건 하나로 합친다는 뜻이 아닙니다. 하드웨어·운영 인력·패치·백업을 공유하면서도 업무 데이터와 권한, 변경 주기를 어느 수준까지 분리할지를 정하는 일입니다. non-CDB 여러 개를 한 host에 올리는 방식도 가능하지만, Oracle 21c 이후에는 multitenant CDB가 지원되는 아키텍처라는 점이 전환 논의의 배경입니다. 통합의 이점은 shared failure domain과 shared capacity라는 비용을 동반합니다.

## CDB 안의 주요 컨테이너

**CDB root** 는 CDB 전체에 필요한 Oracle 제공 메타데이터와 common user, 공통 권한·객체를 담는 root container입니다. root는 각 애플리케이션의 업무 테이블을 보관하는 일반적인 장소가 아닙니다. root에서 넓은 권한으로 작업하면 여러 PDB에 영향을 줄 수 있으므로, DBA의 편의 때문에 일상적인 application schema를 root에 만드는 설계는 피하는 편이 좋습니다.

**PDB$SEED** 는 새 PDB를 만들 때 템플릿으로 쓰이는 Oracle 제공 seed입니다. 새 PDB를 `CREATE PLUGGABLE DATABASE`로 만들면 이 seed를 바탕으로 필요한 구조가 생성됩니다. seed를 일반 업무 PDB처럼 열어 데이터를 넣는 대상이라고 생각하면 안 됩니다. seed의 상태, 패치 수준, 생성 옵션은 이후 만들어질 PDB에 영향을 줄 수 있어 change management 대상입니다.

**user-created PDB** 는 실제 애플리케이션이나 환경을 담는 pluggable database입니다. `sales_pdb`, `reporting_pdb`, `dev_pdb`처럼 목적이 드러나는 이름을 두고, 각 PDB에 local user와 schema, tablespace, service를 둘 수 있습니다. Oracle 공식 문서가 설명하듯 PDB는 schema objects와 non-schema objects의 portable collection이며, Oracle Net client에는 별도 non-CDB처럼 보입니다. 이 이동성은 clone·unplug·plug·relocate 같은 작업을 가능하게 하는 기반입니다.

**application container** 는 선택적인 더 높은 계층입니다. application root에 여러 application PDB가 공유할 application metadata와 common data를 둘 수 있습니다. 같은 제품의 고객별 PDB에 공통 application object를 배포하려는 경우를 생각할 수 있지만, 일반 PDB만으로도 충분한 환경에 불필요하게 도입하면 권한·버전·배포 복잡성만 커질 수 있습니다. 먼저 PDB 단위 분리와 migration 방식이 부족한지 확인하는 편이 낫습니다.

## common과 local의 차이

Multitenant에서 **common user** 는 CDB의 여러 container에 알려진 사용자이고, **local user** 는 하나의 PDB 안에서만 의미가 있는 사용자입니다. 이 구분은 단순 네이밍 규칙이 아니라 권한 범위를 결정합니다. CDB 전체를 관리해야 하는 DBA 계정과, 특정 업무 PDB의 애플리케이션 계정을 같은 방식으로 만들면 너무 넓은 권한을 주기 쉽습니다.

예를 들어 애플리케이션의 `orders_app` 계정은 `sales_pdb` 안에서 필요한 schema만 사용할 local user로 두는 방식이 자연스럽습니다. 반면 CDB backup, patch, resource management를 담당하는 계정은 공통 권한이 필요할 수 있습니다. common user가 모든 PDB의 모든 데이터에 자동으로 접근해도 된다는 뜻은 아닙니다. common privilege와 local privilege, container 범위를 명시하고 least privilege를 적용해야 합니다.

`ALTER SESSION SET CONTAINER = ...` 같은 명령으로 관리자가 container를 전환할 수 있다는 사실도 중요합니다. 잘못된 container에서 DDL을 실행하면 의도하지 않은 PDB 또는 root에 객체·권한 변경을 남길 수 있습니다. 자동화 스크립트는 접속 service, 현재 container 확인, 대상 PDB 이름, 실패 시 중단 조건을 명시해야 합니다. 단순히 `SYSDBA`로 접속해 실행하는 스크립트는 편하지만 영향 범위를 파악하기 어렵습니다.

## 서비스 연결과 애플리케이션 경계

PDB를 만들었다면 애플리케이션이 올바른 service로 접속하는지 확인해야 합니다. connection string에 SID나 root service를 고정한 기존 애플리케이션은 PDB 전환 뒤에도 예상 밖의 container에 들어갈 수 있습니다. 서비스 이름, DNS, listener, TLS, credential, connection pool 설정을 한 세트로 관리합니다. 개발·스테이징·운영 PDB의 서비스 이름이 비슷할 때는 배포 변수 실수로 운영에 접속하는 일을 막기 위해 네트워크·계정·secret까지 별도로 분리해야 합니다.

PDB를 닫거나 열 때 서비스와 application pool의 동작도 같이 봅니다. PDB가 `OPEN` 상태가 아니면 새 접속이 실패할 수 있고, 재시작 뒤 자동으로 열리도록 저장할지 여부도 운영 절차에 포함됩니다. 애플리케이션은 DB 연결 실패를 무한히 재시도하지 말고, timeout·circuit breaker·사용자 오류 안내를 갖춰야 합니다. DBA는 PDB 상태 전환이 롤링 배포, 배치, 모니터링, 백업에 어떤 영향을 주는지 runbook으로 남깁니다.

한 PDB가 문제를 일으켰을 때 다른 PDB의 connection이 정상이라는 사실만으로 CDB가 건강하다고 결론 내릴 수 없습니다. instance CPU·메모리·I/O·redo·shared storage가 공통 병목이 될 수 있습니다. 반대로 특정 PDB의 악성 SQL이나 과도한 batch가 다른 PDB를 밀어내지 않도록 resource management와 용량 관찰을 검토해야 합니다. PDB 수를 늘리는 것보다 workload와 SLA가 서로 어떤 영향을 줄 수 있는지 먼저 측정하는 것이 중요합니다.

## PDB 생성, clone, unplug, plug의 목적

PDB를 만드는 방법은 빈 구조를 seed에서 만드는 것만이 아닙니다. 기존 PDB 또는 non-CDB를 clone할 수 있고, unplug한 PDB를 다른 CDB에 plug할 수 있으며, remote CDB의 PDB를 옮기는 방법도 있습니다. 이 기능들은 “DB 파일을 마음대로 복사해도 된다”는 뜻이 아니라, Oracle이 metadata와 file association을 이해하는 절차로 이동성을 제공한다는 뜻입니다.

clone은 개발·테스트 환경을 빠르게 만들고, 변경 전 검증할 때 유용할 수 있습니다. Oracle 문서는 CDB가 ARCHIVELOG mode이고 local undo mode인 경우 source PDB가 read/write로 운영 중이어도 hot clone을 지원하는 조건을 설명합니다. 하지만 clone 작업의 시간, source 부하, 저장 공간, TDE encryption keystore, 개인정보 마스킹은 별도의 고려 사항입니다. 운영 PDB clone을 테스트에 쓰려면 데이터 최소화·비식별화·접근 만료 정책을 먼저 준비해야 합니다.

unplug은 PDB의 data file과 metadata XML 또는 archive 형태를 내보내고, plug은 이를 다른 CDB에 연결하는 방식입니다. 대상 CDB가 더 높은 Oracle release일 수 있고, plug compatibility를 검사해야 합니다. 다음 SQL은 흐름을 보여 주는 예시이며 실제 파일 경로, 호환성 검사, keystore와 backup 절차 없이 운영에서 실행해서는 안 됩니다.

```sql
ALTER PLUGGABLE DATABASE sales_pdb CLOSE IMMEDIATE;
ALTER PLUGGABLE DATABASE sales_pdb UNPLUG INTO '/secure/export/sales_pdb.xml';

CREATE PLUGGABLE DATABASE sales_pdb
  USING '/secure/export/sales_pdb.xml'
  NOCOPY;
```

`NOCOPY`는 파일을 새 위치로 복사하지 않고 기존 파일을 사용할 수 있다는 의미이므로, 스토리지 경로·소유권·백업·롤백을 이해하지 못한 상태에서 사용하면 위험합니다. unplug이 PDB를 없애거나 사용 불가능하게 하는 단계와 연결될 수 있다는 점도 기억해야 합니다. 작업 전에는 source와 target의 DB version, character set, options, patch level, service name, client connection cutover 계획을 체크리스트로 확인합니다.

## 백업, 복구, 패치의 경계

PDB 단위가 있다는 이유로 백업과 복구가 단순히 PDB별 파일 복사로 끝나는 것은 아닙니다. CDB의 control file, redo, root metadata와 PDB data file의 관계를 이해해야 하고, RMAN과 조직의 복구 목표(RPO/RTO)에 맞는 절차를 검증해야 합니다. 특정 PDB만 복구할 수 있는지, 복구 중 다른 PDB 서비스에 어떤 영향이 있는지, point-in-time recovery가 어디까지 가능한지는 버전과 백업 설계에 따라 달라집니다.

패치는 더 넓은 경계입니다. CDB의 Oracle Home과 root 관련 변경은 여러 PDB에 영향을 줄 수 있습니다. 각 PDB의 application schema migration과 DB engine patch도 순서가 다릅니다. “PDB가 분리돼 있으니 고객 A만 DB patch한다”는 기대는 Oracle Home과 CDB 구조를 공유하는 환경에서는 맞지 않을 수 있습니다. 유지보수 창, PDB open mode, 서비스 drain, 애플리케이션 호환성, rollback을 PDB별 업무 영향과 CDB 공통 영향으로 나누어 계획합니다.

모니터링도 두 계층을 가져야 합니다. CDB 레벨에서는 instance availability, CPU·메모리·I/O, storage, listener, backup, common user 권한 변경을 봅니다. PDB 레벨에서는 service availability, session 수, tablespace 사용량, 실패한 login, long-running SQL, application 오류와 schema migration 상태를 봅니다. 하나의 대시보드에서 모든 PDB를 평균으로 합치면 특정 PDB의 tablespace 고갈이나 runaway query를 놓칠 수 있습니다.

## 언제 PDB 분리가 적합한가

PDB는 환경 또는 제품 단위로 database lifecycle을 분리해야 할 때 특히 유용합니다. 예를 들어 서로 다른 application이 schema migration과 release 시점, backup retention, administrator를 다르게 가져야 한다면 단순 schema 분리보다 PDB 경계가 더 분명할 수 있습니다. 인수한 시스템을 단계적으로 통합하거나, 특정 고객·사업부의 데이터를 이동 가능한 단위로 관리해야 할 때도 검토할 수 있습니다.

반대로 수천 개의 작은 tenant를 모두 PDB로 만들면 connection, service, patch, monitoring, backup catalog, quota, automation 객체가 늘어납니다. PDB마다 반드시 필요한 격리·복구·규제 요구가 있는지 확인해야 합니다. tenant 간 데이터는 row-level security와 tenant key로 충분히 분리하고, 제품별 또는 환경별로만 PDB를 쓰는 혼합 모델도 가능합니다. PDB 수는 기술적으로 가능한 최대값보다 운영자가 장애와 변경을 이해할 수 있는 범위로 정합니다.

또한 PDB는 보안 만능 경계가 아닙니다. CDB root 고권한 계정, shared host OS, shared storage, backup 접근 권한이 침해되면 여러 PDB가 영향을 받을 수 있습니다. 엄격한 규제·상호 불신·서로 다른 암호화 키 관리·독립된 재해 복구가 필요한 워크로드는 별도 CDB 또는 별도 infrastructure가 필요한지 평가해야 합니다. “한 CDB에 있다”는 효율과 “완전히 분리됐다”는 보장은 동시에 얻기 어렵습니다.

## 도입 순서와 자주 생기는 실수

첫 단계는 현재 DB 목록을 업무 단위로 분류하는 것입니다. 각 database의 owner, SLA, 데이터 등급, peak workload, patch window, backup·restore 목표, 연결 애플리케이션, 외부 인터페이스를 적습니다. 그 다음 어떤 DB를 같은 CDB에 두어도 되는지와 절대로 shared failure domain에 두면 안 되는지를 나눕니다. 이 분석 없이 non-CDB를 일괄 변환하면 나중에 PDB 수와 resource contention, 권한 모델을 다시 고치게 됩니다.

두 번째는 작은 비핵심 workload에서 service 연결과 자동화를 검증하는 것입니다. PDB 생성·open·close·service 등록, local user 생성, backup, monitoring, application migration을 반복해 봅니다. `CDB$ROOT`에서 실행할 명령과 target PDB에서 실행할 명령을 runbook에 분리하고, 스크립트가 현재 container를 출력하게 합니다. 성공 경로뿐 아니라 PDB가 열리지 않을 때, service가 잘못된 PDB를 가리킬 때, clone이 저장 공간을 다 쓸 때의 복구 절차도 확인합니다.

세 번째는 대량 전환 전에 실제 애플리케이션 contract를 검증하는 것입니다. connection string의 service name, JDBC driver version, distributed transaction, database link, scheduler job, backup agent, monitoring agent, firewall rule이 PDB 구조와 맞는지 확인합니다. 특히 root 접속 계정을 애플리케이션에 재사용하거나, 개발 PDB의 credential을 운영 PDB에 쓰는 실수는 CDB 구조 자체보다 더 흔한 보안 문제입니다.

## 리소스 관리와 장애 범위를 분리해서 보기

여러 PDB를 한 CDB에 넣는 가장 큰 이유 가운데 하나는 자원을 함께 쓰는 효율입니다. 그러나 공유는 곧 경합 가능성입니다. 한 PDB의 대량 ETL, 잘못된 Cartesian join, 과도한 parallel query, 대량 로그 생성이 instance CPU와 PGA·SGA 메모리, I/O, redo를 사용하면 다른 PDB의 온라인 요청 지연도 커질 수 있습니다. PDB가 논리적으로 분리됐다는 이유로 noisy neighbor 문제가 저절로 사라지지 않습니다.

그래서 용량 계획은 CDB 평균만 보지 않습니다. 각 PDB의 peak session 수, CPU 시간, read·write I/O, temp 사용량, tablespace 증가율, long-running SQL, batch 실행 시간을 따로 기록합니다. 특정 PDB가 전체 CDB 자원의 대부분을 쓰는 순간이 있는지, 월말·정산·백업처럼 workload가 겹치는 시간이 있는지 확인합니다. Oracle의 resource management 기능을 검토할 때도 먼저 어떤 업무를 보호하고 어떤 batch를 늦출 수 있는지 SLA로 정해야 합니다. 기술 설정은 업무 우선순위를 대신 결정하지 않습니다.

장애 경계도 두 단계입니다. PDB의 application schema migration 실패나 tablespace 고갈은 한 PDB에 집중될 수 있습니다. 반면 instance crash, shared storage 오류, listener 문제, Oracle Home patch 실패는 CDB 안의 여러 PDB가 함께 영향을 받을 수 있습니다. PDB를 고객별로 나눴다고 “고객별 독립 장애 복구”를 약속하려면 CDB와 인프라의 공통 의존성을 따로 평가해야 합니다. 고객 계약의 가용성 목표가 다르면 같은 CDB에 둘 수 있는지부터 다시 검토합니다.

DR(Disaster Recovery)과 복구 훈련도 동일한 질문을 던집니다. 특정 PDB만 잘못된 데이터를 되돌려야 할 때 필요한 백업 체인과 권한이 있는지, 전체 CDB failover 뒤 PDB 서비스가 올바르게 시작되는지, DNS와 애플리케이션 pool이 새 위치를 향하는지 확인합니다. 백업 성공 로그만으로 restore 가능성을 증명할 수 없습니다. 주기적으로 격리된 환경에서 restore하고, service 연결과 핵심 query까지 확인하는 훈련이 필요합니다.

## application container는 언제 검토하는가

application container는 같은 제품을 여러 application PDB에 제공하면서 공통 application metadata와 version을 관리하려는 구조입니다. 예를 들어 동일한 SaaS 제품을 여러 고객 PDB에 제공하고, 공통 테이블 정의·PL/SQL package·참조 데이터를 일관되게 배포해야 할 수 있습니다. application root에는 공통 application이 있고, application PDB에는 고객별 local data가 있는 형태를 생각할 수 있습니다.

하지만 이 구조는 공통 객체와 local 객체의 구분, application version upgrade, 각 PDB의 sync 시점, 오류가 난 tenant의 복구가 추가됩니다. 일반적인 CI/CD migration으로 각 PDB schema를 배포하는 방식이 이미 충분하다면 application container를 먼저 도입할 이유가 없습니다. 공통 배포 문제를 해결하려는 목적, PDB 수, tenant별 release 차이, DBA와 개발팀의 운영 책임이 명확할 때만 검토하는 편이 좋습니다.

application root의 변경은 여러 application PDB의 동작에 영향을 줄 수 있으므로, 하나의 고객 PDB에서 먼저 검증하고 전체에 확장하는 배포 전략이 필요합니다. tenant별 custom object가 많다면 공통 버전과 local 수정의 충돌도 생길 수 있습니다. Multitenant의 계층을 늘리는 만큼 장애 조사와 권한 검토의 계층도 늘어난다는 점을 계획에 넣어야 합니다.

## 전환 전 테스트 시나리오

non-CDB 또는 기존 PDB를 옮기는 작업에서는 SQL 문법 통과만 보지 말고 접속부터 운영까지의 시나리오를 작성합니다. 첫째, 올바른 service name으로 접속한 애플리케이션이 예상 PDB에서 현재 container를 확인할 수 있는지 봅니다. 둘째, local user가 필요한 object만 접근하고 root 또는 다른 PDB에 접근하지 못하는지 확인합니다. 셋째, connection pool 재시작, PDB close/open, listener 재시작에서 재연결과 오류 처리가 기대대로인지 확인합니다.

넷째, 배치·scheduler job·database link·외부 ETL이 새로운 service를 사용하는지 확인합니다. 대화형 화면은 정상인데 야간 배치가 예전 non-CDB alias를 보거나 root에 접속하는 경우가 흔합니다. 다섯째, backup 후 restore와 point-in-time recovery의 목표를 작은 데이터로라도 연습합니다. 여섯째, patch와 application migration의 순서, PDB clone 뒤 비식별화와 access revoke까지 확인합니다. 이 목록은 모든 팀에 같은 정답을 강제하지 않지만, PDB 전환에서 자주 빠지는 주변 의존성을 드러냅니다.

## 보안, 라이선스, 자동화까지 포함한 운영 기준

PDB가 분리되어 있다고 해서 데이터 접근 권한이 자동으로 분리되는 것은 아닙니다. 각 PDB의 local user와 schema 권한을 최소로 두고, 애플리케이션이 root의 common user 또는 넓은 DBA 계정으로 접속하지 않도록 해야 합니다. 연결 문자열의 service 이름만 바꾸고 같은 고권한 계정을 재사용하면, PDB를 나눈 이유인 영향 범위 축소가 약해집니다. 서비스별 계정, 읽기·쓰기 역할, 배치 역할, 운영 관리자 역할을 나누고 secret의 소유자와 교체 절차를 기록합니다.

감사 로그도 container 맥락을 남겨야 합니다. 로그인 실패, 권한 변경, schema DDL, 고위험 데이터 조회 같은 이벤트가 발생했을 때 CDB 이름만으로는 어느 업무 PDB의 일인지 알 수 없습니다. PDB 이름, service, local user, client application name, source network, 변경 ticket를 함께 연결하면 조사 속도가 빨라집니다. 반대로 SQL 전문이나 바인드 변수에 개인정보가 포함될 수 있으므로, 감사 수준과 로그 접근 권한, 보존 기간을 데이터 분류 정책에 맞춥니다.

개발·테스트 clone은 특히 주의가 필요합니다. clone PDB는 프로덕션과 비슷한 구조를 빠르게 제공하지만, 그 안에 고객 이름·연락처·주문 내역·접근 토큰·암호화 키 관련 정보가 그대로 들어가면 테스트 편의가 곧 개인정보 사고가 될 수 있습니다. 가능한 경우에는 합성 데이터나 최소 추출 데이터를 사용하고, 꼭 필요한 clone이라면 접근 가능한 사람·네트워크·존속 기간을 제한합니다. clone 직후 비식별화 스크립트, 외부 연동 비활성화, scheduler job 중지, outbound network 차단, 개발 계정만의 credential 교체를 자동화 순서에 넣는 것이 좋습니다.

TDE(Transparent Data Encryption)를 쓰는 환경에서는 PDB 이동과 clone이 keystore 관리와 연결됩니다. Oracle 문서도 암호화된 source PDB나 keystore가 있을 때 clone에 필요한 조건을 별도로 설명합니다. 데이터 파일만 복사해서 테스트 환경에서 열어 보려 하기보다, 키 접근 권한과 복구 절차, 키를 보관하는 시스템의 분리를 먼저 확인해야 합니다. 암호화는 파일을 보호하지만, 복호화 권한이 넓게 퍼지면 보호 효과가 줄어듭니다.

Oracle Multitenant 문서는 버전별로 기능과 표현이 달라지고, Oracle 21c부터 CDB가 지원되는 유일한 아키텍처라고 설명합니다. 그러나 실제로 사용할 수 있는 PDB 수, 고급 clone·refresh·application container 기능, edition과 cloud service별 제공 범위는 계약과 라이선스 문서를 따로 확인해야 합니다. 기술 블로그의 예시를 그대로 견적이나 도입 근거로 쓰면 안 되는 이유입니다.

도입 문서에는 최소한 Oracle Database 버전, edition 또는 cloud service, CDB와 PDB의 예상 수, 사용하는 고급 기능, 담당 벤더·라이선스 확인자를 적어 둡니다. 개발 환경과 운영 환경의 edition이 다르면 clone이나 자동화가 개발에서만 되는 상황이 생길 수 있습니다. 패치 수준도 중요합니다. PDB를 다른 CDB로 plug할 때 버전·component·character set·patch level의 호환성을 확인하지 않으면 cutover 시점에 문제를 만날 수 있습니다.

자동화가 `CREATE PLUGGABLE DATABASE`를 호출할 수 있다고 해서 새로운 PDB를 무제한 만들면 안 됩니다. 이름 규칙, owner, 데이터 등급, 비용 코드, backup policy, 삭제 승인 같은 입력 검증이 먼저입니다. 생성 뒤에는 PDB가 원하는 open mode인지, service가 올바른 listener에 등록됐는지, 애플리케이션 user가 local인지, tablespace와 quota가 설정됐는지, 모니터링과 backup job이 대상 PDB를 발견했는지 확인해야 합니다. 성공 코드만으로 운영 준비가 끝났다고 판단하면 안 됩니다.

삭제와 이동은 생성보다 더 신중히 다룹니다. PDB를 drop하거나 unplug할 때 snapshot·backup·보존 의무·연결 중인 application·서비스 DNS·비밀값·monitoring rule이 남을 수 있습니다. 삭제 전에는 데이터 보존 기간과 법적 hold를 확인하고, 실제로 더 이상 client session이 없는지, 복구 가능한 backup이 있는지, 의도치 않게 같은 이름의 다른 PDB를 대상으로 하지 않는지 확인합니다. 이름만 비슷한 개발·스테이징·운영 PDB를 구분하는 보호 장치가 필요한 이유입니다.

마지막으로 PDB 운영은 DBA만의 작업이 아닙니다. 애플리케이션 팀은 service와 pool의 오류 처리, 보안 팀은 계정·감사·비식별화, 플랫폼 팀은 storage·network·backup, 제품 팀은 tenant별 SLA와 데이터 보존을 책임집니다. 각 팀이 같은 CDB/PDB 목록과 변경 계획을 보고 있어야, 통합의 효율이 책임 공백으로 바뀌는 일을 막을 수 있습니다.

## PDB 상태와 변경 창을 운영 언어로 바꾸기

PDB는 `MOUNTED`, `OPEN READ ONLY`, `OPEN READ WRITE`처럼 상태를 가질 수 있고, 상태 전환은 application의 연결 가능 여부와 변경 가능 범위에 영향을 줍니다. DBA에게는 익숙한 상태 정보라도 제품팀에는 “지금 고객이 주문을 조회할 수 있는가”, “배치가 실행되는가”, “schema migration을 적용해도 되는가”라는 질문으로 번역되어야 합니다. 변경 창 안내에는 PDB 이름만 적기보다 영향을 받는 service와 기능, 예상 오류, 재개 확인 기준을 함께 씁니다.

예를 들어 clone 또는 plug 작업 전에 source PDB를 read only로 바꿔야 하는 조건이 있을 수 있습니다. 이때 connection pool이 오래 열린 connection을 유지하는지, 쓰기 요청이 즉시 실패하는지, 사용자에게 재시도 안내를 줄지 확인합니다. 작업이 끝난 뒤 단순히 PDB를 open하는 것으로 끝내지 않고, listener의 service 등록, application health check, 대표 read/write transaction, background job 재개, monitoring alert 정상화를 확인해야 합니다. 데이터베이스 상태와 서비스 상태가 항상 동시에 바뀌지는 않기 때문입니다.

변경 승인에도 PDB 단위와 CDB 단위를 구분합니다. 특정 PDB의 application migration이라면 해당 서비스 owner의 검토가 중심이지만, Oracle Home patch나 root 설정 변경이라면 같은 CDB의 모든 PDB owner가 영향 평가에 들어가야 합니다. 반대로 고객 한 곳의 문제를 해결하려고 root에서 공통 파라미터를 바꾸면 다른 PDB의 위험을 놓칠 수 있습니다. 작업 계획에는 대상 container, 실행 계정, 예상 lock·중단, 관찰 지표, rollback 기준을 명시합니다.

## 성능 문제를 발견했을 때의 조사 순서

한 PDB에서 응답이 느려졌을 때 첫 반응으로 CDB를 더 크게 만들기보다, 문제를 PDB·instance·스토리지·애플리케이션 경계로 나눠 봅니다. 해당 PDB의 active session, top SQL, wait event, tablespace와 temp 사용량, 최근 schema 변경을 보고, 동시에 다른 PDB의 batch나 backup이 자원을 쓰는지 확인합니다. 같은 시간의 host CPU·I/O latency·redo 생성량을 비교하면 local query 문제와 shared resource contention을 구분하는 실마리를 얻을 수 있습니다.

해결책도 원인에 맞춰야 합니다. 잘못된 index나 실행계획이 원인이면 PDB의 SQL·통계·schema를 고쳐야 하고, 특정 batch가 공통 I/O를 밀어내면 실행 시간이나 resource policy를 조정해야 하며, CDB 전체 용량이 부족하면 scale-up 또는 workload 분리가 필요할 수 있습니다. PDB를 다른 CDB로 옮기는 것은 강력하지만 connection·backup·운영 경계까지 바꾸는 작업이므로, 단순한 일시적 부하에 대한 첫 선택지가 되어서는 안 됩니다.

이처럼 Multitenant의 핵심은 여러 DB를 담는 상자가 아니라, 문제의 영향 범위와 변경 책임을 더 명확히 읽게 하는 구조라는 점입니다. PDB별 관찰과 CDB 공통 관찰을 함께 갖추면 통합의 이점은 유지하면서도 한 업무의 문제가 다른 업무에 번지는 경로를 더 빨리 찾을 수 있습니다.

운영 지표를 처음부터 완벽하게 만들 필요는 없습니다. 각 PDB의 service availability, session 수, tablespace 사용량, 오류율과 CDB의 CPU·I/O·backup 상태처럼 최소 항목부터 같은 시간대에 모읍니다. 이후 실제 장애와 변경 사례를 보며 어떤 지표가 원인을 좁히는 데 도움이 됐는지 추가하면 됩니다. 중요한 것은 평균값만 보고 모든 PDB가 정상이라고 결론 내리지 않는 습관입니다.

또한 운영자 교대와 신규 인력 온보딩 때 CDB와 PDB 목록, 서비스 소유자, 공통 장애와 개별 장애의 분류 기준을 함께 전달해야 합니다. 구조를 아는 사람 한 명에게만 의존하면, 통합으로 줄이려던 관리 비용이 지식 공백으로 다시 커질 수 있습니다. 짧은 runbook과 정기 복구 연습은 도구 설정만큼 중요한 운영 자산입니다.

## 한계와 적용 기준 Q&A

<section class="quick-answers">
  <p class="quick-label">한계와 적용 기준</p>
  <div class="quick-answer"><h3>Q. PDB가 있으면 tenant 간 성능 간섭이 사라지나요?</h3><p>A. 아닙니다. CDB instance와 host 자원을 공유하면 CPU·I/O·메모리·redo 경합이 남습니다. resource management와 workload 관찰, 필요하면 물리 분리가 필요합니다.</p></div>
  <div class="quick-answer"><h3>Q. 개발 DB를 PDB clone으로 만들면 데이터를 그대로 써도 되나요?</h3><p>A. 안 됩니다. 운영 데이터의 개인정보·비밀·계약 정보는 별도 접근 통제와 비식별화 정책이 필요합니다. clone은 기술적 복사 기능이지 데이터 사용 허가가 아닙니다.</p></div>
  <div class="quick-answer"><h3>Q. PDB마다 별도 service를 꼭 써야 하나요?</h3><p>A. 애플리케이션이 특정 PDB로 명확히 연결되도록 service 경계를 두는 것이 일반적으로 안전합니다. root 또는 공용 연결 정보를 사용하면 대상 container를 혼동할 수 있습니다.</p></div>
  <div class="quick-answer"><h3>Q. non-CDB를 PDB로 옮기면 바로 운영 전환해도 되나요?</h3><p>A. 아닙니다. 호환성, patch·character set, service 연결, 권한, backup/restore, 성능과 롤백을 스테이징에서 검증해야 합니다. 변환 자체보다 주변 연결의 변경이 더 큰 위험일 수 있습니다.</p></div>
</section>

## 마무리: PDB는 파일 분할이 아니라 운영 경계다

Oracle Multitenant의 CDB·PDB 구조는 여러 데이터베이스를 하나의 운영 기반 위에서 관리하면서, 애플리케이션에는 분리된 데이터베이스 경험을 제공하는 방식입니다. 중요한 것은 PDB를 많이 만드는 데 있지 않습니다. 어떤 workload가 lifecycle·권한·복구·규제상 함께 있어도 되는지, 어떤 경계는 별도 CDB나 별도 인프라가 필요한지를 명확히 하는 데 있습니다.

처음에는 service가 명확한 작은 PDB 하나와 제한된 애플리케이션에서 시작하세요. CDB root와 PDB의 권한을 분리하고, clone·backup·restore·service cutover를 실제 절차로 검증하면 Multitenant를 단순한 최신 용어가 아니라 예측 가능한 데이터베이스 운영 도구로 사용할 수 있습니다.

<h3 class="references-heading">참고 자료</h3>

- [Oracle Multitenant Architecture Introduction](https://docs.oracle.com/en/database/oracle/oracle-database/26/multi/introduction-to-the-multitenant-architecture.html)
- [Oracle Multitenant Architecture Overview](https://docs.oracle.com/en/database/oracle/oracle-database/18/multi/overview-of-the-multitenant-architecture.html)
- [Oracle Creating and Removing PDBs](https://docs.oracle.com/en/database/oracle/oracle-database/18/multi/creating-pdbs.html)
- [Oracle Cloning a PDB](https://docs.oracle.com/en/database/oracle/oracle-database/21/multi/cloning-a-pdb.html)
- [Oracle Database Licensing Information](https://docs.oracle.com/en/database/oracle/oracle-database/23/dblic/)
