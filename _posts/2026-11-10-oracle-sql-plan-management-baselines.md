---
layout: post
title: "Oracle SQL Plan Management를 설계하는 법: 실행 계획 안정화·Baseline·변경 검증의 경계"
categories: [DBA]
tags: [oracle, sql-plan-management, sql-plan-baseline, optimizer, performance, dba]
description: "Oracle SQL Plan Management의 SQL plan baseline과 진화 과정을 기반 개념부터 설명하고, 실행 계획 회귀를 줄이면서 변경을 검증하는 운영 기준을 정리합니다."
---

## 먼저 답하기

### Q. SQL Plan Baseline을 만들면 SQL 성능 문제가 모두 해결되나요?

A. 아닙니다. SQL Plan Management(SPM)는 optimizer가 검증된 실행 계획을 우선 사용하도록 도와 plan regression 위험을 줄이는 기능입니다. 잘못된 index, 오래된 통계, 데이터 분포 변화, 비효율적인 SQL 자체, resource 부족, lock 대기를 고쳐 주지는 않습니다. baseline은 "현재 좋은 결과를 내는 계획을 무조건 영구 고정한다"는 버튼이 아니라, 계획 변경을 검증 가능한 절차로 다루는 도구입니다.

### Q. 업그레이드 전에 모든 SQL에 baseline을 만들어야 하나요?

A. 모든 SQL에 무차별로 적용하면 관리할 계획이 늘고 더 나은 optimizer 개선을 막을 수 있습니다. 결제·정산·권한 조회처럼 영향이 큰 SQL, 과거에 plan 변동으로 incident가 있었던 SQL, upgrade·patch·통계 변경 전후에 회귀 가능성이 큰 SQL부터 우선순위를 정합니다. workload와 평가 기준 없이 baseline 수만 늘리는 것은 운영 안정성이 아닙니다.

## 먼저 알아둘 기반 기술

### 실행 계획과 optimizer

SQL은 "어떤 결과를 원하는가"를 선언하고, Oracle optimizer는 table access, join 순서, join 방식, index 사용, sort·aggregation 방법 같은 실행 계획을 고릅니다. 같은 SQL text라도 table 크기, column 통계, bind 값, partition 상태, parameter, database version, available resource에 따라 다른 계획이 선택될 수 있습니다. 새 계획이 항상 나쁜 것은 아니지만, 특정 데이터 분포에서만 매우 느려지거나 resource를 많이 쓰는 regression이 생길 수 있습니다.

실행 계획은 개발자가 고정한 순서가 아니라 optimizer의 비용 추정 결과입니다. 비용이 낮게 보이는 계획이 실제로도 빠르려면 통계와 cardinality 추정이 현실과 가까워야 합니다. 실제 row 수와 추정 row 수가 크게 다르면 nested loop와 hash join 선택, index range scan과 full scan 선택이 달라질 수 있습니다. plan이 바뀌었다는 사실보다 왜 바뀌었고 업무 결과·응답 시간·resource에 어떤 영향이 있는지가 더 중요합니다.

### SQL plan baseline의 개념

SQL plan baseline은 특정 SQL에 대해 optimizer가 사용할 수 있다고 승인한 계획 집합입니다. baseline 안에는 accepted 여부, enabled 여부, fixed 여부 같은 속성이 있을 수 있습니다. optimizer가 새 계획을 찾더라도 승인되지 않은 계획을 바로 사용하지 않게 하거나, 기존 계획과 비교·검증한 뒤 더 나은 계획을 진화(evolve)시키는 흐름을 만들 수 있습니다. 세부 동작과 사용 가능한 기능은 Oracle Database version과 설정에 따라 공식 문서로 확인해야 합니다.

SPM은 SQL Profile이나 SQL Patch와 목적이 다릅니다. SQL Profile은 optimizer 추정을 보정하는 추가 정보를 줄 수 있고, SQL Patch는 특정 SQL에 hint를 적용하는 방식으로 쓰일 수 있습니다. baseline은 승인된 계획을 관리하는 정책에 더 가깝습니다. 이름이 비슷한 기능을 상황과 원인을 보지 않고 섞으면, 문제를 가린 채 관리 대상만 늘릴 수 있습니다.

## 계획 회귀가 생기는 대표 상황

database upgrade나 RU(Release Update), optimizer parameter 변경, 통계 갱신, index 생성·삭제, partition 추가, data volume 성장, bind 값 분포 변화는 계획 선택에 영향을 줄 수 있습니다. 예를 들어 작은 고객의 주문만 조회하던 SQL이 index range scan으로 빠르다가, 특정 대형 고객의 데이터가 늘면서 같은 bind 조건에서 많은 row를 읽게 될 수 있습니다. 이때 단순히 예전 plan을 baseline으로 고정하면 단기 문제는 피할 수 있어도 데이터 성장에 맞는 설계 개선을 미룰 수 있습니다.

회귀 조사는 먼저 SQL ID와 정확한 SQL text, 실행 시각, bind와 모듈 정보, 계획 hash, 실제 row·elapsed time·CPU·I/O 같은 관찰 데이터를 연결합니다. application log의 request ID와 database session 정보를 연결할 수 있으면 고객 영향과 SQL 실행을 더 잘 대조할 수 있습니다. 단, bind 값이나 SQL text에는 개인정보·업무 비밀이 있을 수 있으므로 조사 자료의 접근 권한과 마스킹을 지켜야 합니다.

계획 차이가 보이면 source data와 target data가 같은지, statistics가 같은지, cache warm-up과 동시 workload가 다른지 먼저 확인합니다. 한 번 느렸다는 이유만으로 baseline을 만들면 일시적 resource 경합을 optimizer 문제로 오인할 수 있습니다. 반대로 반복되는 특정 plan change가 핵심 업무를 지연시킨다면, 원인 분석과 함께 검증된 계획을 보호하는 방법을 검토할 수 있습니다.

## Baseline을 도입하는 절차

첫 단계는 업무 우선순위입니다. 모든 SQL을 수집하기보다 결제 승인, 월말 정산, 고객 권한 확인, 주문 조회처럼 실패 비용이 큰 기능의 SQL과 과거 장애 SQL을 고릅니다. 각 SQL에는 정상 결과, 허용 가능한 경과 시간 또는 batch window, 예상 row count, 관련 application release, 담당자를 기록합니다. 이 기준이 없으면 새 plan을 받아들일지 거절할지 판단할 수 없습니다.

다음은 baseline 후보가 실제로 좋은 계획인지 검증하는 단계입니다. 계획 하나가 빠르다고 해도 특정 bind에서만 좋거나 다른 transaction과 동시에 실행될 때 lock·I/O를 키울 수 있습니다. production에서 임의 hint를 강제하기 전에 test 또는 승인된 replay 환경에서 representative bind와 workload로 결과를 비교합니다. 결과 정확성, 완료 여부, 경과 시간, resource 사용, 영향받는 다른 SQL을 함께 봅니다.

그 뒤 승인된 계획을 baseline으로 관리하고, 새 후보 계획은 자동으로 즉시 받아들이지 않거나 별도 검증으로 진화시킬 수 있습니다. 이 정책은 조직의 위험도에 맞춰야 합니다. 고객 결제처럼 회귀 비용이 큰 SQL은 보수적으로, 분석성 query처럼 workload와 데이터가 자주 바뀌는 SQL은 더 넓게 실험할 수 있습니다. baseline의 목적은 optimizer를 멈추는 것이 아니라 중요한 계획 변경을 보이지 않게 배포하지 않는 것입니다.

## 업무 예시: 주문 목록 조회 plan 회귀

주문 목록 API가 `customer_id`, 기간, 상태 조건으로 최근 주문을 조회한다고 가정합니다. 평소에는 index를 이용해 제한된 row를 빠르게 찾지만, 통계 갱신 뒤 full table scan과 큰 sort를 하는 plan이 선택돼 일부 고객의 화면이 느려졌다고 합시다. DBA와 개발자는 우선 실제 문제가 된 SQL ID, bind 범위, 예상·실제 row 수, 새·기존 plan, 동시 workload를 확인합니다.

이 SQL이 고위험 API라면 이전의 검증된 plan을 baseline 후보로 등록하는 것을 검토할 수 있습니다. 하지만 동시에 왜 새 plan이 선택됐는지도 조사합니다. 복합 index의 순서가 조건과 맞지 않는지, histogram이 오래됐는지, 특정 customer의 데이터가 과도하게 커졌는지, pagination 방식이 전체 sort를 유발하는지 봅니다. baseline은 고객 화면을 보호하는 임시 또는 장기 안전망이 될 수 있지만, 데이터 모델·SQL·통계 결함을 해결한 증거는 아닙니다.

수정한 index나 SQL을 test environment에서 검증한 뒤에는 새 계획을 바로 production 기본값으로 바꾸지 않고, 결과 행 수·정렬·권한 조건이 기존과 같은지와 다른 workload의 영향까지 확인합니다. 계획을 진화시킬 때도 성공한 평균 시간만 보지 말고 대형 고객, 빈 결과, 넓은 기간, 동시 요청 같은 사례를 비교합니다. 이렇게 해야 baseline이 특정 한 번의 빠른 실행을 보존하는 장치가 아니라 업무 계약을 지키는 운영 절차가 됩니다.

## Baseline의 속성과 운영 의미

baseline에서 enabled는 optimizer가 해당 plan을 사용할 수 있는지, accepted는 검증된 plan으로 인정되는지, fixed는 다른 후보보다 우선시할지와 관련된 속성입니다. 정확한 우선순위와 버전별 동작은 문서를 확인해야 하지만, 운영 관점에서는 속성을 바꾼 이유와 되돌리는 조건을 남기는 것이 더 중요합니다. fixed plan을 많이 만들면 예측 가능성은 높아질 수 있지만 optimizer가 더 나은 plan을 선택할 여지를 잃을 수 있습니다.

자동 capture와 자동 evolve도 편리하지만 통제 없이 켜면 예상하지 못한 SQL과 plan이 관리 대상에 들어갈 수 있습니다. 어떤 schema·module·SQL을 대상으로 하는지, 새 후보를 자동 accept할지, 검증 job이 어느 환경에서 어떤 workload로 실행되는지 정합니다. automation은 사람이 SQL을 일일이 등록하는 부담을 줄이지만, 승인 기준과 감사 기록을 없애지 않습니다.

baseline repository도 database 메타데이터와 용량을 사용합니다. 더 이상 실행되지 않는 SQL, 중복된 plan, 폐기된 application version의 baseline을 정리하지 않으면 조사와 관리가 어려워집니다. plan을 삭제하기 전에는 해당 SQL이 실제로 사라졌는지, rollback release가 다시 필요로 하지 않는지, 다른 module이 같은 SQL signature를 쓰지 않는지 확인합니다. 수명주기 관리는 성능 기능에도 필요합니다.

## Baseline과 데이터 변화의 관계

baseline을 적용한 SQL도 시간이 지나면 데이터와 workload가 달라집니다. 월별 partition이 추가되고, 고객 수가 늘고, 한 상태 값에 row가 몰리고, archive 정책으로 오래된 data가 줄면 과거에 좋은 plan이 더 이상 가장 적절하지 않을 수 있습니다. 이때 baseline이 있다는 이유로 통계 갱신이나 schema 개선을 미루면, plan은 안정적이지만 비용이 계속 증가하는 상태가 될 수 있습니다. 안정성은 변화가 없다는 뜻이 아니라 변화를 검증하고 받아들이는 과정입니다.

통계 갱신 전후에는 어떤 SQL이 중요한지와 plan이 바뀌었는지를 관찰합니다. 통계가 실제 분포를 잘 표현하지 못한다면 histogram, extended statistics, stale threshold, partition statistics 같은 원인을 검토할 수 있습니다. 무조건 hint나 fixed baseline으로 되돌리기보다, optimizer가 왜 다른 cardinality를 추정했는지 확인합니다. 다만 원인 분석 중에도 고객 영향이 크다면 승인된 baseline으로 단기 보호를 하고, 근본 수정과 재검증 일정을 별도로 둡니다.

bind variable도 plan 안정성에 영향을 줍니다. 작은 고객과 대형 고객의 조건 값이 같은 SQL text로 들어올 때 한 plan이 모두에게 적합하지 않을 수 있습니다. bind peeking, adaptive behavior, 데이터 skew 같은 세부 동작은 version별로 다를 수 있으므로 실제 plan과 row count를 보고 판단해야 합니다. 특정 bind 사례만 빠른 baseline을 전체 workload에 강제하면 다른 고객에게 회귀를 만들 수 있습니다.

## 변경 전후 검증 흐름

database patch, parameter 변경, index migration, application release를 준비할 때는 baseline을 먼저 대량 생성하는 것보다 검증 대상 SQL을 좁힙니다. 첫째, AWR·application monitoring·incident 이력에서 high impact SQL과 업무 transaction을 고릅니다. 둘째, 기준 환경에서 SQL text·plan·대표 bind·결과 row·경과 시간과 오류를 기록합니다. 셋째, 변경 환경에서 같은 조건 또는 대표 workload로 실행하고 SQL Performance Analyzer, execution plan, application 정합성 테스트를 함께 봅니다.

차이가 발견되면 오류·정확성·시간·resource를 분리합니다. 결과 row가 달라졌다면 성능 tuning보다 data 또는 application compatibility 문제를 먼저 봅니다. 결과는 같지만 시간이 길어졌다면 plan, statistics, I/O, concurrent workload, cache 상태를 비교합니다. plan은 같지만 시간이 길어졌다면 database 밖의 resource 경합이나 network·storage 차이일 수 있습니다. 이 분류 없이 plan baseline을 추가하면 실제 원인이 남습니다.

검증을 통과한 새 계획을 accept할 때는 SQL ID만 기록하지 말고 변경 이유, test data 범위, 평가 날짜, 담당자, rollback 기준을 남깁니다. 배포 뒤에는 baseline이 실제로 사용됐는지, 예상하지 못한 plan이 선택되지 않았는지, 핵심 API와 batch window가 기준 안에 있는지 관찰합니다. 변경 후 관찰이 없으면 baseline은 사전 검증 기록과 실제 운영 사이가 끊긴 정책이 됩니다.

## SQL Performance Analyzer와 Database Replay의 구분

SQL Performance Analyzer는 SQL workload 단위에서 계획·성능 변화를 비교하는 데 유용합니다. 여러 SQL의 regression 후보를 빠르게 찾고, 어떤 SQL을 더 깊게 검토할지 정하는 데 도움을 줄 수 있습니다. 하지만 하나의 SQL을 독립적으로 실행하는 비교는 실제 동시 transaction, lock, commit 순서, application connection pattern을 모두 표현하지 않습니다. SQL 결과가 좋아도 실제 업무 흐름이 항상 좋아진다는 보장은 없습니다.

Database Replay는 실제 database workload의 동시성·session 상호작용을 재현하려는 기능으로, upgrade처럼 넓은 변경의 영향을 볼 때 보완 수단이 될 수 있습니다. 반면 준비 비용과 데이터·보안 경계가 더 큽니다. 핵심 SQL의 plan regression만 조사한다면 SPA와 representative test가 먼저일 수 있고, batch와 online transaction이 겹이는 위험까지 봐야 한다면 replay를 검토할 수 있습니다. 어떤 도구도 application unit·integration·E2E 테스트를 대체하지 않습니다.

두 도구와 SPM의 관계는 경쟁이 아니라 단계입니다. 관찰로 위험 SQL을 찾고, 분석으로 새 계획의 영향을 보고, 필요한 경우 baseline으로 승인된 계획을 보호하며, 더 넓은 workload로 변경을 검증합니다. 조직의 license와 환경, 변경 위험에 맞춰 필요한 부분만 사용합니다. 도구가 많다는 이유로 모든 release에 무거운 절차를 강제하면 오히려 중요한 검증이 형식화될 수 있습니다.

## Baseline 운영 자동화의 경계

SQL plan baseline의 capture, load, evolve, purge를 job으로 자동화할 수 있습니다. 그러나 자동 job이 accepted plan을 대량으로 늘리거나, 오래된 plan을 근거 없이 삭제하거나, production에서 resource를 과도하게 쓰면 안정성을 위한 기능이 위험이 됩니다. job의 실행 시간, 대상 schema, 최대 작업량, 실패 알림, 결과 검토 책임자를 정합니다. automation은 반복 작업을 줄이되 승인 판단을 숨기지 않아야 합니다.

자동 evolve가 후보 plan을 검증할 때는 어떤 기준 데이터와 resource 조건을 쓰는지도 중요합니다. 작은 test data에서 빠른 plan이 실제 대형 table에서 좋다는 보장은 없고, 동시 workload가 없는 환경에서의 결과는 제한적입니다. 자동 결과를 즉시 production accept로 연결하기보다, high-risk SQL에는 사람이 검토하는 queue를 두거나 canary release와 운영 관찰을 연결할 수 있습니다.

baseline 관련 job과 view 접근 권한도 최소화합니다. 모든 개발자가 production의 plan을 fixed 또는 drop할 수 있으면, 성능 tuning이 배포 통제를 우회하는 통로가 됩니다. 변경 요청과 audit record를 남기고, 긴급 조치에는 만료·사후 검토·원상 복구 조건을 둡니다. 성능 기능도 data와 availability에 영향을 주는 운영 권한이라는 점을 잊지 않아야 합니다.

## 업무 기준을 plan 지표와 연결하기

DBA가 `elapsed time`과 `buffer gets`를 보고, 제품 팀이 주문 완료율과 batch deadline을 보면 같은 문제가 다른 언어로 보일 수 있습니다. baseline 판단에는 두 관점을 연결해야 합니다. 주문 조회 SQL이 두 배 빨라져도 결과 정렬이 바뀌거나 권한 filter가 빠지면 성공이 아닙니다. batch SQL이 조금 느려져도 정해진 window 안에 끝나고 다른 workload를 덜 방해한다면 수용 가능한 변경일 수 있습니다.

SQL별 성공 기준을 업무 언어로 적습니다. 예를 들어 "월말 정산이 오전 6시 전에 완료되고 총액·건수 검증이 일치한다", "고객 주문 목록이 권한 조건을 지키면서 허용 latency 안에 반환된다"처럼 씁니다. 이 기준에는 데이터 규모와 대표 조건, 허용 오류, 담당자를 포함합니다. 그 뒤 plan hash와 row estimate, wait event 같은 기술 지표를 조사 근거로 연결합니다.

이 기록은 성능 수치를 약속하는 문서가 아닙니다. 사용자가 명시하지 않은 실제 측정 결과를 꾸며서는 안 되며, 특정 환경의 결과를 다른 환경에 일반화해서도 안 됩니다. 대신 어떤 SQL과 workload를 어떤 기준으로 확인해야 하는지, baseline을 언제 만들고 언제 해제할지 설명하는 운영 계약이 됩니다.

## 장애 시 임시 안정화와 사후 개선

production에서 급격한 plan regression이 고객 기능을 막는다면, 이미 검증된 baseline이나 승인된 SQL Patch 같은 임시 조치가 복구 시간을 줄일 수 있습니다. 그러나 긴급 조치는 원인을 제거한 것이 아닙니다. 조치 뒤 실제 plan과 결과를 확인하고, statistics·index·SQL·data skew·parameter 중 무엇이 변화를 만들었는지 incident review에서 분석합니다. 임시 fixed plan의 owner와 만료·재검토 날짜를 남겨 두지 않으면 emergency 설정이 영구 기술 부채가 됩니다.

rollback도 plan 하나를 삭제하는 것으로 끝나지 않습니다. application version, schema migration, cache, parameter, data backfill이 함께 바뀌었다면 이전 plan이 현재 data와 호환되는지 확인해야 합니다. rollback할 수 없는 data 변경이 있으면 application의 fallback 경로와 보상 절차를 먼저 설계합니다. SPM은 database 내부의 계획을 관리하지만, 실제 서비스의 rollback은 여러 계층의 계약을 포함합니다.

## 팀 협업과 문서화

baseline 목록은 DBA 개인의 메모가 아니라 shared operational inventory여야 합니다. 각 항목에 SQL의 업무 이름, owner, baseline을 둔 이유, 관련 release·incident, 검증 환경, fixed 여부, 마지막 검토일, 제거 조건을 적습니다. 민감한 SQL text나 bind 값은 권한 있는 저장소에 분리하고, 일반 문서에는 식별자와 업무 맥락만 남길 수 있습니다.

개발자는 ORM 또는 query builder가 SQL text와 bind 방식을 바꾸는 release를 DBA와 공유하고, DBA는 계획 변화와 통계·index 위험을 개발 팀에 설명합니다. 제품·운영 담당자는 어떤 화면과 batch deadline이 중요하며 어느 정도의 느려짐이 고객 영향인지 알려 줍니다. 이 협업이 없으면 baseline은 database만 최적화하고 제품 실패를 놓치거나, 제품 일정이 optimizer의 위험을 모른 채 진행될 수 있습니다.

## Index와 baseline의 우선순위

plan regression을 발견했을 때 index를 추가하거나 baseline을 fixed로 만드는 선택이 자주 나옵니다. index는 특정 읽기 SQL을 빠르게 할 수 있지만 insert·update·delete의 유지 비용과 storage를 늘리고, 다른 SQL의 optimizer 선택도 바꿀 수 있습니다. baseline은 검증된 계획을 보호할 수 있지만 데이터 변화에 따른 개선 기회를 제한할 수 있습니다. 어느 하나가 항상 더 낫지 않으므로, 문제 SQL의 read/write 비율, table 성장, index 선택도, batch window, 운영 위험을 함께 봅니다.

예를 들어 주문 목록 조회가 느린 이유가 기간 조건 없이 모든 고객 row를 sort하기 때문이라면, 새로운 index만으로 요구사항 문제를 해결하지 못할 수 있습니다. pagination, 검색 조건, archive 분리, summary table 같은 application·data design 개선이 필요할 수 있습니다. 반대로 적절한 composite index가 있는데 통계 문제로 사용되지 않았다면 statistics 개선과 plan 검증이 먼저일 수 있습니다. baseline은 이런 근본 수정이 검증되는 동안 고객 영향을 낮추는 안전망으로 쓸 수 있습니다.

index를 추가한 뒤에는 대상 SQL만 benchmark하지 않습니다. 쓰기 transaction의 redo·undo, lock, batch, storage, backup 시간, 다른 query plan의 변화를 함께 봅니다. 동일한 SQL이 baseline 때문에 기존 index를 계속 쓰면 새 index가 기대대로 사용되지 않을 수도 있습니다. 변경의 성공은 하나의 execution plan 그림이 아니라 전체 workload와 업무 deadline에서 판단해야 합니다.

## Plan hash와 SQL ID를 읽는 한계

SQL ID와 plan hash value는 조사에 유용한 식별자지만, 그 숫자만으로 실행의 모든 의미를 표현하지는 않습니다. 같은 plan hash여도 bind 값, 실제 row 수, cache 상태, concurrent workload가 달라 elapsed time은 달라질 수 있습니다. plan hash가 달라졌다고 반드시 regression도 아닙니다. join order나 access path가 바뀌었어도 결과가 같고 자원 사용과 완료 시간이 더 좋을 수 있습니다.

따라서 incident나 release 보고에는 SQL ID·plan hash와 함께 module, action, schema, database version, stats 시점, 대표 bind의 범주, 실제·예상 row, 오류, wait event, 업무 영향 범위를 남깁니다. 모든 상세를 공개 문서에 넣을 필요는 없고, 민감값은 권한 있는 조사 기록으로 분리합니다. 핵심은 나중에 동일한 현상을 다시 보고 비교할 수 있는 충분한 맥락을 남기는 것입니다.

ORM이 literal 값을 매번 SQL text에 넣는 방식이라면 비슷한 query가 서로 다른 SQL ID로 쌓여 baseline 관리와 shared cursor 효율이 나빠질 수 있습니다. 반대로 bind를 쓴다고 모든 데이터 분포 문제를 자동으로 해결하는 것은 아닙니다. application의 SQL 생성 방식, cursor sharing, bind 유형과 길이, database optimizer behavior를 함께 관찰하고, 성급하게 global parameter를 바꾸지 않습니다.

## 계획 진화의 승인 기준

새 plan 후보를 받아들일 때는 이전 plan보다 빠른지 하나만 보지 않습니다. 결과 정확성, null·empty·large range 같은 경계 bind, 높은 동시성, memory·temp 사용, 다른 query에 미치는 영향, batch와 online traffic의 공존을 평가합니다. 새 plan이 소규모 데이터에서는 좋지만 대형 고객에서만 느리다면, 평가셋이 고객 분포를 대표하지 못한 것입니다. 대표 조건을 늘리고 위험 그룹을 나눠 비교해야 합니다.

승인 기준은 서비스별로 다를 수 있습니다. customer-facing query는 p95 latency와 오류·결과 정합성을, overnight batch는 완료 시각·총액 검증·resource contention을 더 중요하게 볼 수 있습니다. 어떤 기준도 사용자가 명시하지 않은 직접 측정 수치를 만들어 내서는 안 됩니다. 대신 조직이 실제 환경에서 측정하고 합의해야 할 항목을 release checklist로 두면 됩니다.

새 plan을 accepted로 바꾼 뒤에도 이전 plan을 즉시 제거하지 않을 수 있습니다. rollback 기간, application release 안정화 기간, 다음 통계 갱신 일정을 고려해 보관 정책을 정합니다. 그러나 모든 과거 plan을 영구 보관하면 optimizer 후보와 관리 부담이 늘어납니다. 보관 기간·마지막 사용·관련 release를 기준으로 정리하고, 삭제 전에 복구 가능성과 영향 SQL을 검토합니다.

## Monitoring과 baseline drift

baseline이 적용돼도 예상 밖의 문제가 생길 수 있습니다. baseline이 실제로 사용되지 않았거나, 새로운 SQL text가 baseline과 매칭되지 않았거나, 같은 plan에서 data·resource 환경이 달라졌을 수 있습니다. 그래서 high-risk SQL은 plan 사용 여부와 latency·error·row volume을 관찰합니다. monitoring은 모든 SQL의 detail을 무기한 수집하는 일이 아니라, 업무 영향이 큰 query의 변화를 release와 연결하는 일입니다.

drift는 baseline 목록과 실제 workload가 멀어지는 현상입니다. 애플리케이션이 새 query를 사용하거나 module 이름이 바뀌고, baseline owner가 떠나고, test workload가 오래된 데이터만 쓰면 목록은 남아 있어도 보호 효과는 줄어듭니다. 정기 review에서 최근 실행 SQL, baseline 사용 여부, 고아 plan, 새 high-load SQL, stats·schema 변경을 확인합니다. review 결과는 유지·진화·폐기·추가 검증 중 하나의 행동으로 이어져야 합니다.

## 안전한 실험과 권한 분리

production에서 optimizer parameter나 plan을 바꾸는 실험은 영향이 클 수 있습니다. 가능한 경우 test database 또는 승인된 clone에서 먼저 실행하고, representative data와 workload로 결과를 비교합니다. target이 production보다 작거나 storage가 다르면 성능 절대값을 일반화하지 않고, compatibility와 plan 변화 탐지에 한계를 둡니다. 변경 전 backup·rollback path·관찰 담당자·중단 조건을 준비합니다.

SPM 관련 패키지와 dictionary view 접근은 DBA 권한을 요구할 수 있습니다. 개발 편의를 위해 광범위한 권한을 배포 파이프라인에 주면 SQL tuning이 production 변경 경계를 우회할 수 있습니다. read-only 관찰, baseline 후보 등록, accepted/fixed 변경, purge를 역할별로 나누고 감사 log를 남깁니다. 긴급 조치도 ticket·만료·사후 review를 통해 정상 운영으로 되돌아가게 합니다.

## 작은 시작의 예시

처음부터 모든 SQL을 자동 capture하지 말고, 다음처럼 한 업무 흐름으로 시작할 수 있습니다. 1) 월말 정산의 상위 SQL과 완료 기준을 목록화한다. 2) 기준 release에서 plan·결과·실행 조건을 기록한다. 3) database patch target에서 SQL과 representative batch를 실행한다. 4) 오류·결과·시간·plan 차이를 분류한다. 5) 검증된 계획만 baseline 후보로 승인하고 배포 뒤 batch 완료와 error를 관찰한다. 6) 다음 cycle에서 불필요한 후보와 임시 fixed plan을 재검토한다.

이 절차는 특정 명령을 외우는 것보다, 계획 변경을 제품 변화처럼 다루게 합니다. 작은 inventory와 명확한 owner·rollback 기준만으로도 "느려지면 hint를 넣자"는 대응보다 안전한 출발점이 됩니다. workload가 커지면 SQL Performance Analyzer, Database Replay, 자동 evolve 같은 도구를 필요와 license 조건에 맞춰 추가할 수 있습니다.

## 운영 변경과 release gate

high-risk SQL의 plan change는 database 내부의 tuning 작업으로만 닫지 않습니다. application release, schema migration, statistics job, patch schedule과 연결된 release gate로 다룹니다. 예를 들어 migration이 새로운 index를 만들거나 partition을 추가한다면, 관련 SQL의 baseline·plan·결과 검증을 release checklist에 넣고, 배포 뒤 어느 dashboard에서 latency와 batch completion을 볼지 정합니다. 이 연결이 없으면 DBA가 안전하다고 본 계획이 application deployment에서 다른 SQL text로 바뀌거나, 개발 팀이 rollback 가능한지 모른 채 database parameter를 변경할 수 있습니다.

gate는 모든 변경을 막기 위한 관문이 아니라, 위험이 큰 변경에 필요한 증거를 명확히 하는 장치입니다. low-risk reporting query는 작은 test와 관찰로 충분할 수 있고, 결제·정산·권한 SQL은 representative data와 승인된 workload 검증이 필요할 수 있습니다. 검증하지 못한 항목은 통과처럼 숨기지 않고, rollout 범위를 줄이거나 관찰을 강화하거나 다음 window로 미루는 선택을 합니다.

## baseline이 맞지 않는 경우

SQL text가 계속 바뀌는 ad-hoc 분석, 데이터 분포가 빠르게 변하는 탐색 query, 결과가 캐시·외부 상태에 크게 의존하는 query는 baseline 관리의 이점이 작을 수 있습니다. 이 경우 plan을 고정하기보다 query 제한, workload isolation, resource governance, summary data, 사용자 입력 제약을 검토합니다. baseline은 모든 느린 SQL에 붙이는 스티커가 아니라, 계획 안정성이 실제 업무 가치가 있는 경우에만 쓰는 정책입니다.

또한 결과 정확성 문제가 있는 SQL은 baseline으로 해결할 대상이 아닙니다. 잘못된 join, 누락된 tenant filter, timezone 변환 오류, pagination 중복은 빠른 plan으로 실행돼도 제품 결함입니다. 먼저 요구사항과 데이터 계약을 고치고, 그 뒤 성능을 검증해야 합니다. 속도와 정확성을 서로 바꾸는 선택처럼 다루면 안 됩니다.

## 정기 검토의 질문

baseline review에서는 "이 plan이 아직 실행되는가", "처음 보호한 업무 위험이 아직 존재하는가", "새 statistics·index·data growth 아래에서도 기준을 만족하는가", "fixed 또는 accepted 속성이 여전히 필요한가"를 묻습니다. 답이 없으면 baseline을 유지하는 이유도 약해집니다. 반대로 여전히 고위험 SQL인데 owner와 검증 기록이 없다면, plan을 삭제하기보다 책임과 평가 기준을 보완해야 합니다.

검토 결과는 유지, 새 후보 평가, fixed 해제, 임시 조치 연장, 폐기 중 하나로 기록합니다. 어떤 결론이든 근거와 다음 확인 시점을 남기면 SPM은 과거 장애의 흔적이 아니라 계속 관리되는 안정성 장치가 됩니다.

## DBA와 개발자가 함께 보는 확인 항목

release 전에는 DBA가 plan과 database resource만 보고 개발자가 API 테스트만 보는 식으로 나누지 않습니다. SQL이 어떤 endpoint 또는 batch에서 실행되는지, 변경한 ORM·migration이 SQL text와 bind를 바꾸는지, 결과 row와 정렬이 사용자 요구를 지키는지, SQL 오류가 application에서 어떻게 표현되는지 함께 확인합니다. 이 연결이 있어야 baseline이 성능 개선처럼 보이면서 권한·결과 정확성 회귀를 숨기는 일을 막을 수 있습니다.

배포 뒤에도 application metric과 database metric을 같은 시간축으로 봅니다. 특정 SQL의 plan이 바뀐 뒤 주문 API의 p95가 증가했는지, batch 시작 시각과 completion window가 변했는지, database wait가 늘었지만 고객 오류는 없는지 비교합니다. 한 지표만으로 원인을 단정하지 않고, release·data growth·외부 load 변화를 함께 기록합니다.

## 운영 가능한 최소 정책

작은 팀은 고위험 SQL 목록, owner, 마지막 검증일, 현재 baseline 상태, rollback 방법을 한 표로 시작할 수 있습니다. 새 baseline을 추가할 때는 업무 이유와 검증 근거를, fixed로 바꿀 때는 만료 또는 재검토 날짜를 적습니다. 이 최소 정책만으로도 무작정 hint를 추가하거나 오래된 plan을 방치하는 위험을 줄일 수 있습니다.

규모가 커지면 자동 capture·evolve·SPA·replay를 도입할 수 있지만, 목록과 승인 기준이 없는 자동화는 관리 대상을 빠르게 늘릴 뿐입니다. 먼저 설명 가능한 정책을 만든 뒤 반복 작업만 자동화하는 순서가 안정적입니다.

계획 안정화의 최종 목적은 optimizer의 선택을 제한하는 것이 아니라, 데이터와 workload가 바뀌는 상황에서도 중요한 업무 결과를 예측 가능하게 지키는 데 있습니다. 이 목적을 기준으로 baseline을 만들고 검토하면 성능과 운영 안전을 함께 다룰 수 있습니다.

정책의 효과와 예외를 반복해 확인하는 습관이 임시 tuning을 장기적인 운영 지식으로 바꿉니다.

## 한계와 적용 기준 Q&A

### Q. baseline을 만들면 통계 갱신을 하지 않아도 되나요?

A. 아닙니다. 통계는 optimizer가 현재 데이터 특성을 추정하는 데 필요합니다. 오래된 통계 때문에 잘못된 계획이 선택된 문제를 baseline으로 숨기면 다른 SQL의 품질이 계속 나빠질 수 있습니다. 통계 갱신 정책, data distribution, 계획 변화를 함께 관리하세요.

### Q. fixed baseline이 가장 안전한 선택인가요?

A. 단기 회귀 위험이 큰 핵심 SQL에는 유용할 수 있지만 모든 SQL에 적용하면 개선 기회를 막고 관리 부담을 키울 수 있습니다. fixed가 필요한 업무 이유, 검증 기간, 해제·재검토 조건을 두고 사용하세요.

### Q. SQL text가 조금 바뀌면 같은 baseline이 적용되나요?

A. SQL signature와 baseline 매칭은 SQL text와 정규화 방식 등 여러 조건에 영향받을 수 있습니다. 공백·주석·literal 처리, ORM이 만든 SQL 형태, bind 사용 방식이 바뀌면 기대대로 적용되지 않을 수 있습니다. release 전 실제 SQL과 적용 여부를 확인해야 합니다.

### Q. plan regression은 DBA만 해결해야 하나요?

A. 아닙니다. schema, index, query 작성, pagination, data lifecycle, application release, statistics, infrastructure가 모두 영향을 줄 수 있습니다. DBA는 optimizer와 운영 관찰을 제공하고, 개발·제품 팀은 업무 요구와 SQL 변경을 함께 검토해야 합니다.

## 마무리

Oracle SQL Plan Management는 실행 계획을 영원히 고정하는 기능이 아니라, 중요한 SQL의 계획 변경을 업무 기준과 검증 절차 안으로 가져오는 도구입니다. 고위험 SQL부터 후보를 정하고, 실제 결과와 workload로 plan을 검증하며, baseline 속성·진화·정리를 운영 기록으로 관리하세요. 그러면 upgrade와 데이터 변화 속에서도 optimizer의 유연성을 모두 잃지 않으면서 계획 회귀의 위험을 줄일 수 있습니다.

<h3 class="references-heading">참고 자료</h3>

- [Oracle Database 23ai SQL Tuning Guide: Managing SQL Plan Baselines](https://docs.oracle.com/en/database/oracle/oracle-database/23/tgsql/managing-sql-plan-baselines.html)
- [Oracle Database 23ai SQL Tuning Guide](https://docs.oracle.com/en/database/oracle/oracle-database/23/tgsql/)
- [Oracle Database 23ai Real Application Testing User's Guide: SQL Performance Analyzer](https://docs.oracle.com/en/database/oracle/oracle-database/23/ratug/sql-performance-analyzer.html)
- [Oracle Database 23ai Performance Tuning Guide](https://docs.oracle.com/en/database/oracle/oracle-database/23/tgdba/)
