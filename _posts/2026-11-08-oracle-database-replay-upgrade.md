---
layout: post
title: "Oracle Database Replay를 이해하는 법: 실제 워크로드 캡처·재현·업그레이드 검증의 경계"
categories: [DBA]
tags: [oracle, database-replay, real-application-testing, workload, upgrade, dba]
description: "Oracle Database Replay의 워크로드 캡처·전처리·재현·분석 흐름을 바탕으로, 업그레이드와 설정 변경 전 실제 업무 부하를 검증하는 방법과 한계를 설명합니다."
---

## 먼저 답하기

### Q. Oracle Database Replay는 부하 테스트 도구와 같은가요?

A. 완전히 같지 않습니다. 부하 테스트는 가상의 사용자와 요청을 만들어 목표 트래픽에서 시스템이 버티는지 확인하는 데 적합합니다. Oracle Database Replay는 운영 데이터베이스에서 관찰한 실제 database workload를 캡처해, 별도로 준비한 test system에서 가능한 한 비슷한 순서와 동시성으로 재현하는 기능입니다. 따라서 특정 애플리케이션의 실제 SQL·transaction 패턴을 기반으로 upgrade나 parameter 변경의 영향을 비교하는 데 도움을 줄 수 있지만, production을 그대로 복제하거나 미래의 최대 부하를 예측하는 도구는 아닙니다.

### Q. 운영 워크로드를 캡처해도 개인정보와 변경 위험은 없나요?

A. 아닙니다. workload에는 SQL text, bind 값, 객체 이름, 사용자 식별자처럼 민감할 수 있는 정보가 포함될 수 있고, replay 대상 database에는 실제 DML(Data Manipulation Language, 데이터 변경 SQL)이 실행될 수 있습니다. 그래서 capture와 replay 모두 승인된 범위에서 수행하고, 대상 환경을 production과 분리하며, 데이터 마스킹·접근 제어·네트워크 차단·복구 계획을 준비해야 합니다. Database Replay는 검증 기능이지 무단으로 운영 데이터를 복사하거나 운영에 명령을 다시 실행해도 된다는 허가가 아닙니다.

## 먼저 알아둘 기반 기술

### 데이터베이스 워크로드란 무엇인가

워크로드(workload)는 데이터베이스가 일정 시간 동안 처리한 작업의 묶음입니다. 사용자가 실행한 `SELECT`, `INSERT`, `UPDATE`, `DELETE`, PL/SQL 호출, commit·rollback, 세션 연결과 종료, 동시에 실행된 요청의 관계가 포함될 수 있습니다. 같은 초당 쿼리 수라도 읽기와 쓰기 비율, 특정 table과 index에 몰리는 접근, transaction 길이, bind 값 분포, 동시 session 수가 다르면 database가 받는 압력과 실행 계획은 달라질 수 있습니다.

예를 들어 온라인 쇼핑몰은 점심 시간에 상품 조회가 많고, 자정에는 정산 batch와 재고 갱신이 몰릴 수 있습니다. 평균 CPU 사용률만 보고 두 시간을 같다고 보면 안 됩니다. 하나는 cache에 잘 맞는 짧은 read가 많고, 다른 하나는 긴 transaction·lock 대기·대량 sort가 섞일 수 있습니다. upgrade나 설정 변경이 어떤 업무에 영향을 주는지 보려면, 단순한 평균 수치보다 업무가 실제로 만든 요청의 형태를 이해해야 합니다.

### 캡처·전처리·재현·분석의 흐름

Database Replay는 큰 흐름에서 workload capture, preprocess, replay, analysis로 생각할 수 있습니다. 먼저 production 또는 승인된 source에서 관찰 구간의 workload를 캡처합니다. 다음으로 replay client가 사용할 수 있게 파일을 전처리합니다. 준비된 test database에서 원본과 호환되는 스키마·데이터·의존성을 갖춘 뒤, 여러 replay client가 작업을 재현합니다. 마지막으로 replay 결과와 기준 결과를 비교해 오류·응답 시간·처리량·실행 특성의 차이를 분석합니다.

각 단계는 서로 다른 질문을 답합니다. capture는 "어떤 업무를 대표 사례로 골랐는가", preprocess는 "재현 도구가 읽을 수 있는 입력인가", replay는 "새 환경에서 같은 workload가 어떤 결과를 냈는가", analysis는 "관찰한 차이가 변경 때문인지 환경 차이인지"를 다룹니다. 한 단계가 성공했다고 다음 단계의 신뢰까지 자동으로 생기지 않습니다. 예를 들어 replay가 완료돼도 source와 target의 데이터가 다르거나 외부 서비스 응답이 달랐다면 결과를 같은 조건의 비교라고 볼 수 없습니다.

### Oracle Real Application Testing의 위치

Oracle Database Replay는 Real Application Testing(RAT) 기능군에서 제공되는 workload 검증 기능입니다. RAT에는 SQL Performance Analyzer처럼 SQL workload의 성능 변화를 비교하는 도구도 포함됩니다. Database Replay는 SQL 하나의 plan만 보는 대신, 동시 session과 transaction 상호작용이 있는 database workload 전체를 다룰 수 있다는 점이 특징입니다. 사용 가능 여부와 라이선스 조건은 Oracle 계약과 제품 문서를 별도로 확인해야 하며, 기능 이름만 보고 모든 Oracle Database 환경에서 무상으로 쓸 수 있다고 가정하면 안 됩니다.

## 왜 업그레이드 전 검증에 쓰는가

Oracle Database upgrade, patch 적용, initialization parameter 변경, OS·스토리지 교체, database 설정 변경은 애플리케이션 코드가 같아도 결과를 바꿀 수 있습니다. optimizer가 다른 execution plan을 선택하거나, 동시성·메모리·I/O 특성이 달라지거나, 오래된 SQL이 호환성 문제를 보일 수 있습니다. 단위 테스트와 소수의 수동 시나리오만으로는 production에서 드물게 일어나는 긴 transaction이나 batch와 온라인 요청의 충돌을 모두 떠올리기 어렵습니다.

실제 관찰 workload는 이 사각지대를 줄이는 후보가 됩니다. 예를 들어 월말 정산, 출근 시간 로그인, 대량 조회 API, 야간 batch처럼 영향이 큰 구간을 선택하면 단순한 synthetic benchmark보다 업무 특성을 더 반영할 수 있습니다. 하지만 capture가 과거의 한 구간일 뿐이라는 한계도 명확히 해야 합니다. 새 기능 출시, 계절성 이벤트, 데이터 증가, 외부 시스템 변화는 과거 capture에 없을 수 있으므로, replay 결과를 "production이 반드시 안전하다"는 보증으로 해석하면 안 됩니다.

Database Replay의 강점은 실패나 차이를 발견했을 때 출발점을 제공하는 데 있습니다. 새 database version에서 오류가 난다면 어떤 session·SQL·시점에서 차이가 났는지 조사할 수 있고, 처리 시간이 달라졌다면 특정 workload class나 SQL plan을 더 살필 수 있습니다. 검증의 목표는 더 높은 숫자를 만드는 것이 아니라 변경 후에도 중요한 업무가 기대한 계약을 지키는지, 위험한 차이가 있다면 배포 전에 원인을 알 수 있는지 확인하는 것입니다.

## 준비 단계: 대표 workload를 고르는 기준

### 업무 중요도와 시간대를 함께 선택하기

캡처 기간을 길게 잡는다고 자동으로 좋은 대표성이 생기지는 않습니다. 너무 짧으면 특정 transaction을 놓치고, 너무 길면 파일·분석 비용이 커져 결과를 해석하기 어려워질 수 있습니다. 먼저 고객·금전·권한·정산·배치처럼 영향이 큰 업무를 목록으로 만들고, 그 업무가 실제로 활발한 시간대와 월말·주말·이벤트 같은 변동 조건을 찾습니다. 운영 모니터링, job schedule, application release 이력, 장애 이력을 근거로 선택 이유를 남기면 더 낫습니다.

예를 들어 평일 오전의 로그인·주문 workload와 월말 야간 정산 workload는 별도 capture로 다루는 편이 이해하기 쉽습니다. 두 구간을 한 파일에 섞으면 평균은 생산적일 수 있어도, batch가 온라인 요청의 latency에 미치는 영향이나 특정 시간대 오류를 분리하기 어렵습니다. 우선순위가 높은 workload부터 작은 실험으로 시작하고, 검증 목적이 분명해질수록 범위를 넓히는 방법이 안전합니다.

### source와 target의 비교 가능성

replay target은 production이 아니어야 하지만, 비교에 필요한 조건은 충분히 맞아야 합니다. schema 정의, 통계 정보, 데이터 양과 분포, partition 상태, character set, timezone, database parameter, patch 수준, storage 성능, 네트워크 지연이 크게 다르면 관찰된 차이가 upgrade 때문인지 환경 차이인지 알기 어렵습니다. production과 동일한 하드웨어를 항상 만들 수 없다면, 무엇이 다른지 문서화하고 결과 해석의 한계로 포함해야 합니다.

데이터는 특히 중요합니다. 10억 행 table을 1만 행으로 축소하면 index 선택·join 방식·sort·redo 생성량·lock 경쟁이 달라질 수 있습니다. 반대로 production 데이터를 무단 복사하면 개인정보와 영업 비밀을 노출할 수 있습니다. 승인된 마스킹 규칙으로 업무 관계와 데이터 분포를 가능한 유지할지, 제한된 합성 데이터로 특정 SQL 오류만 확인할지 목적에 따라 결정합니다. data masking 뒤 foreign key·unique 제약·참조 관계가 깨지지 않는지 검증하는 단계도 필요합니다.

### 안전한 분리와 접근 통제

target database에는 실수로 production endpoint나 외부 메일·결제·메시지 시스템에 연결되지 않도록 네트워크와 credential을 분리합니다. DML replay가 실제 고객에게 알림을 보내거나 외부 장부를 바꾸면, 검증이 데이터 사고가 될 수 있습니다. outbound endpoint를 차단하거나 sandbox로 바꾸고, 필요한 경우 replay 계정의 권한과 schema를 제한하고, 실험 후 환경을 원상 복구할 수 있는 snapshot 또는 backup을 준비합니다.

캡처 파일도 보호 대상입니다. 파일에는 SQL statement, object name, bind 값과 사용자 맥락이 들어갈 수 있으므로, 일반 artifact 저장소에 무기한 공개하지 않습니다. 접근 권한, 암호화, 보관 기간, 삭제 책임자, 분석 결과에 민감값을 마스킹하는 규칙을 정합니다. source database에서 capture를 시작하는 권한 역시 DBA 개인의 편의가 아니라 변경 승인과 감사 기록의 일부로 다뤄야 합니다.

## 실행 흐름을 단계별로 이해하기

### 1. 변경 가설과 성공 기준을 먼저 적기

도구 명령부터 실행하면 "무엇을 비교하려는가"가 흐려집니다. 예를 들어 목표가 19c에서 23ai 계열로 upgrade할 때 정산·주문 workload의 오류와 처리 특성을 확인하는 것인지, 특정 parameter를 바꿨을 때 동시 update의 대기 양상을 보는 것인지 먼저 적습니다. 성공 기준도 평균 응답 시간 하나가 아니라, 치명 오류가 없어야 한다, 특정 업무 transaction이 완료돼야 한다, 데이터 정합성 검사가 통과해야 한다, 계획 변화가 검토돼야 한다처럼 정합니다.

기준에는 중단 조건도 필요합니다. target에서 예상하지 못한 대량 DML, 보안 경계 위반, 외부 endpoint 연결, database 오류 급증이 보이면 분석을 위해 계속 돌리기보다 replay를 멈추고 환경을 격리해야 합니다. 성능 실험은 생산성 높은 작업이지만, 안전한 실험 경계 안에서만 가치가 있습니다.

### 2. workload capture와 확인

capture 전에는 source의 시간, database version, patch, workload 시작·종료 시각, 활성 애플리케이션 release, 주요 batch 상태를 기록합니다. capture가 끝난 뒤에는 파일이 생성됐다는 사실만 보지 말고 선택한 시간대와 업무가 실제로 포함됐는지, 오류나 누락 징후가 있는지, 너무 짧거나 비정상적으로 조용한 구간은 아닌지 확인합니다. capture window 안에 장애나 maintenance가 있었다면, 그 구간을 의도적으로 포함한 것인지 제거해야 하는 잡음인지 표시합니다.

Oracle 도구의 구체적 명령·권한·디렉터리 설정은 database version과 운영 정책에 맞춰 공식 문서를 따라야 합니다. 예시는 흐름을 이해하기 위한 의사 코드로만 보세요.

```text
1. 캡처 목적·시간대·승인을 기록한다.
2. source에서 승인된 범위의 workload capture를 시작하고 종료한다.
3. capture 파일을 보호된 저장소로 옮긴다.
4. replay client가 사용할 수 있도록 전처리한다.
5. 격리된 target에서 replay 전 점검을 한다.
6. baseline과 변경 target에 같은 기준으로 replay하고 결과를 비교한다.
```

### 3. target 준비와 사전 검증

target에는 replay 전에 업무 데이터의 정합성과 애플리케이션 의존성을 확인합니다. 필요한 schema 객체가 있는지, 통계와 권한이 준비됐는지, 연결 문자열이 안전한 endpoint를 가리키는지, disk·archive log·undo·temp 공간이 실험 규모를 감당하는지 봅니다. replay가 실패했을 때 용량 부족이나 권한 오류처럼 upgrade와 무관한 원인이면, 결과를 성능 회귀로 해석하면 안 됩니다.

baseline target과 변경 target을 나눌 수 있다면 비교가 더 명확해집니다. 같은 capture를 upgrade 전 환경과 upgrade 후 환경에 각각 실행해 오류·throughput·response time·대기 이벤트·SQL plan 차이를 봅니다. 완전히 동일한 장비가 아니라면 절대 시간보다 동일 환경 내 상대 차이를 조심스럽게 해석하고, 반복 실행의 편차도 관찰합니다. 한 번의 결과만으로 parameter 하나가 원인이라고 결론 내리기보다, 실행 조건과 재현 가능성을 확인하세요.

### 4. replay와 결과 분석

replay 중에는 단순히 완료 여부만 보지 않습니다. database alert log와 오류, session·transaction 완료 상태, replay client의 오류, resource 사용량, 주요 SQL의 plan 변화, lock·I/O·CPU 대기, 데이터 정합성 검사를 함께 봅니다. 처리량이 높아졌어도 특정 업무 transaction이 오류로 빠졌다면 성공이라고 말할 수 없습니다. 반대로 일부 시간이 길어졌다고 해도 source와 target의 storage·cache warm-up 차이인지 확인하지 않으면 잘못된 회귀 판단을 할 수 있습니다.

결과 차이는 분류해야 합니다. syntax 또는 compatibility 오류, privilege·object 누락, 데이터 차이, optimizer plan 변화, resource 부족, 외부 dependency 차이, timing으로 인한 concurrency 차이처럼 유형을 나누면 다음 행동이 달라집니다. SQL plan 변화는 항상 나쁜 것이 아니고, 기존 plan 유지가 항상 좋은 것도 아닙니다. 중요한 것은 해당 plan이 업무 결과·완료 시간·resource 사용·안정성에 어떤 영향을 주는지 근거로 판단하는 것입니다.

## Database Replay와 SQL Performance Analyzer를 함께 볼 때

SQL Performance Analyzer는 SQL workload의 실행 계획과 성능 변화를 비교하는 데 초점을 둡니다. 개별 SQL의 plan regression을 찾는 데 유용할 수 있지만, 실제 concurrent transaction, session scheduling, commit 순서, lock 경쟁까지 모두 표현하지는 않습니다. 반대로 Database Replay는 workload 상호작용을 볼 수 있지만, 문제를 발견했을 때 어떤 SQL이 plan 차이를 만들었는지 더 깊은 분석이 필요할 수 있습니다.

따라서 두 접근은 대체 관계가 아니라 질문이 다릅니다. upgrade 전에 중요 SQL 목록의 plan·오류 변화를 빠르게 검토하고, 동시성·batch·online traffic이 섞일 때의 behavior가 걱정되면 Database Replay를 검토할 수 있습니다. 애플리케이션 단위 테스트, schema migration 검증, 기능 E2E도 여전히 필요합니다. database workload가 정상이라고 해서 화면·외부 API·비즈니스 규칙까지 자동으로 검증된 것은 아닙니다.

## 업무 예시: 정산 batch와 주문 API가 겹치는 업그레이드

한 커머스 서비스가 Oracle Database upgrade를 앞두고 있다고 가정합니다. 평소 주문 API는 짧은 조회·insert 중심이고, 자정 정산 batch는 대량 update와 집계 query를 수행합니다. 운영에서 두 작업이 겹치는 구간에 lock 대기나 처리 지연이 있었던 적이 있다면, 단일 SQL benchmark만으로는 위험을 충분히 보기 어렵습니다. 팀은 주문 API가 활발하고 정산이 시작되는 승인된 시간 창을 대표 workload 후보로 정합니다.

먼저 source에서 capture하기 전 개인정보·결제 토큰이 포함될 수 있는 bind와 로그의 처리 방침, target의 외부 연결 차단, 정산 job이 실제로 외부 장부를 호출하지 않도록 하는 대체 설정을 검토합니다. target에는 마스킹된 주문·재고·정산 데이터와 필요한 schema·index·통계를 준비하고, baseline과 upgrade target의 차이를 기록합니다. 실험의 성공 기준은 "오류 없음"만이 아니라 주문 생성·정산 완료·재고 음수 방지 같은 데이터 정합성 확인과 주요 대기·오류의 허용 기준을 포함합니다.

replay 뒤 특정 집계 SQL의 처리 시간이 달라졌다면, 평균만 보고 upgrade를 중단하거나 승인하지 않습니다. 실행 plan, 통계, data distribution, parallel 설정, target storage 차이, 동시에 실행된 session을 조사합니다. 주문 API의 오류가 없다면 정산 query를 별도 재현해 개선할 수 있고, 반대로 주문 commit이 지연되면 batch schedule 분리나 query·index 조정, 자원 설정을 검토할 수 있습니다. 결론은 "replay를 통과했다"가 아니라 어떤 workload에서 어떤 근거로 위험을 수용하거나 줄였는지입니다.

## 흔한 오해와 실패 예방

첫째, production capture는 production clone을 만든다는 오해입니다. capture는 workload 관찰 기록이며 target의 데이터·외부 시스템·물리 자원을 그대로 만들지 않습니다. 결과를 읽을 때 무엇이 비슷하고 무엇이 다른지 계속 확인해야 합니다. 둘째, replay가 오류 없이 끝나면 upgrade가 완벽하다는 오해입니다. capture에 없는 사용자 흐름, 미래 데이터 증가, 새 release, 네트워크 장애는 여전히 남습니다. replay는 배포 근거 중 하나이지 단독 승인 도장이 아닙니다.

셋째, 성능 수치를 절대값으로만 비교하는 오류입니다. target 장비나 storage가 다르면 10% 차이가 database software 변경 때문인지 인프라 차이인지 알 수 없습니다. 환경 차이를 통제하거나 결과에 표시하고, 같은 target에서 baseline과 변경 조건을 비교하며, 반복 실행 결과를 봐야 합니다. 넷째, replay용 계정과 네트워크 권한을 넓게 주는 문제입니다. 실험이 실제 시스템을 건드릴 수 있는 경로는 처음부터 차단해야 합니다.

## 재현 충실도를 높이는 세 가지 관점

### 시간과 동시성의 충실도

workload에는 SQL 목록만 있는 것이 아니라 요청이 겹치는 방식이 있습니다. 같은 두 `UPDATE`라도 순차로 실행하면 문제가 없지만, 동시에 같은 row를 잡으려 하면 lock 대기와 transaction 순서가 달라질 수 있습니다. Database Replay가 유용한 이유 중 하나는 이런 동시성 맥락을 다루려는 데 있습니다. 그렇다고 target에서 모든 timing이 source와 비트 단위로 같아진다고 기대하면 안 됩니다. CPU 수, storage 지연, scheduler, network, background process가 다르면 session의 실제 진행 순서도 달라질 수 있습니다.

따라서 분석에서는 완벽한 동일성보다 중요한 상호작용이 보존됐는지를 봅니다. 정산 batch와 주문 transaction이 같은 시간 창에서 겹였는지, 이전에 관찰한 대기나 오류가 target에서도 나타나는지, 변경 target에서 새로운 오류 군이 생겼는지가 더 유용한 질문입니다. 특정 transaction 순서가 업무 정합성에 결정적이라면, replay 결과에만 맡기지 말고 별도의 transaction 테스트와 데이터 검증을 추가해야 합니다.

### 데이터와 통계의 충실도

Oracle optimizer는 table row 수만 보지 않고 column 통계, histogram, index, partition, bind 값에 따라 plan을 선택할 수 있습니다. 마스킹 또는 축소한 target 데이터가 production과 다른 분포를 가지면, target에서 빠른 SQL이 production에서 느리거나 그 반대일 수 있습니다. 특히 skew가 큰 상태 값, 최근 날짜에 몰린 row, 고객별 데이터 편차, 빈 partition은 plan 변화에 영향을 줄 수 있습니다.

이 때문에 실험 보고서에는 데이터 규모뿐 아니라 어떤 분포·통계·partition 상태를 유지했는지 적는 편이 좋습니다. 모든 production 특성을 복제할 수 없다면, 성능 절대값 검증이 아니라 compatibility·오류 탐지에 범위를 한정하는 것도 정직한 선택입니다. 중요한 SQL은 SQL Performance Analyzer, execution plan 비교, representative bind 값을 이용한 추가 검증으로 보완할 수 있습니다. 데이터 충실도를 모르는 상태에서 replay 수치만 배포 근거로 쓰는 것보다, 제한을 명시하는 편이 더 안전합니다.

### 외부 의존성의 충실도

database workload가 애플리케이션 전체 workload와 같은 것은 아닙니다. 애플리케이션은 cache, message queue, object storage, 인증 provider, 외부 결제 API, scheduler와 상호작용할 수 있습니다. Database Replay는 database에 도달한 작업을 중심으로 하므로, 외부 서비스의 timeout이나 API schema 변경, browser에서의 사용자 입력 오류를 그대로 재현하지 않습니다. target에서 외부 호출을 막는 것이 안전에 필요할수록 이 차이는 더 커집니다.

따라서 replay 계획에는 어떤 경계를 포함하고 어떤 경계를 분리해 검증하는지 써야 합니다. 예를 들어 database upgrade는 replay로 동시 SQL과 transaction을 보고, 메시지 consumer의 멱등성은 통합 테스트로, 실제 payment callback은 provider sandbox에서, 화면 흐름은 E2E로 확인할 수 있습니다. 하나의 실험이 모든 계층을 대표한다는 주장보다, 각 검증의 빈틈이 서로 어떻게 보완되는지 설명하는 편이 출시 판단에 유용합니다.

## 비교 기준과 결과 보고서 만들기

replay 결과는 수많은 파일과 지표를 남길 수 있습니다. 결론을 "성공" 또는 "실패" 한 줄로 압축하면 나중에 판단 근거를 검토하기 어렵습니다. 보고서는 최소한 목적, 대상 변경, capture 범위, source·target 환경 차이, 데이터 처리 방식, 외부 연결 차단 방식, 성공·중단 기준, 발견한 차이, 후속 조치를 포함하는 것이 좋습니다. 이 구조는 도구 화면의 숫자를 사업·개발·운영 담당자가 함께 이해할 수 있는 결정 기록으로 바꿉니다.

비교 지표는 업무 결과와 기술 지표를 함께 둡니다. 업무 결과에는 주문·정산·가입 같은 핵심 transaction이 완료됐는지, expected row count와 잔액·상태 전이가 맞는지, 재처리나 오류가 없었는지가 들어갈 수 있습니다. 기술 지표에는 오류 코드, replay divergence, SQL response time, throughput, CPU·I/O·wait event, 실행 plan 변화가 들어갈 수 있습니다. 어느 하나만 좋아도 합격이라는 뜻은 아닙니다. 더 빠르게 끝났지만 일부 transaction이 누락됐다면 위험한 결과입니다.

차이가 발견되면 영향도와 재현성을 분리해 적습니다. 예를 들어 특정 SQL의 경과 시간이 길어졌지만 핵심 batch window 안에 끝나고 반복 실행에서 일관적인지, 특정 오류가 한 번만 발생했는지 모든 반복에서 발생했는지, source에도 이미 있던 오류인지 변경 후 새로 생긴 오류인지 구분합니다. 그 다음 담당자·수정 가설·재실험 조건·배포 전 차단 여부를 정합니다. 원인 미상의 큰 차이를 "test 환경 탓"으로 넘기면 replay를 한 의미가 약해집니다.

## 실험을 반복 가능하게 만드는 runbook

한 번 성공한 replay가 다음 patch에서도 같은 가치가 있으려면, 사람이 기억하는 절차가 아니라 반복 가능한 runbook이 필요합니다. runbook에는 변경 요청 번호, database home과 patch 버전, parameter file, schema·data snapshot 식별자, capture 이름과 시간 범위, 전처리 결과, replay client 구성, target 연결 정보의 안전한 참조, 시작·중단·정리 명령의 책임자를 기록할 수 있습니다. credential 자체는 문서나 source control에 넣지 않고 승인된 secret 관리 위치를 참조합니다.

실험 전 checklist에는 target이 production과 분리됐는지, outbound 연결이 차단 또는 sandbox인지, 사용 가능한 tablespace·undo·temp·archive log 공간이 충분한지, backup 또는 snapshot이 있는지, 모니터링 담당자가 있는지 넣습니다. 실험 후 checklist에는 replay 프로세스 종료, 대상 데이터 정리 또는 snapshot 복구, 임시 credential 폐기, capture와 로그 보관 정책 적용, 결과 보고서 연결을 넣습니다. 시작보다 정리 단계가 약하면 테스트 환경이 다음 실험의 숨은 상태가 됩니다.

자동화할 수 있는 부분은 자동화하되, 승인과 위험 판단까지 숨기지 않습니다. 예를 들어 target 준비와 상태 수집은 script로 반복할 수 있지만, source에서 capture할 시간대와 민감 데이터 처리, production 배포 승인 여부는 책임자가 검토해야 합니다. 자동화는 절차의 일관성을 높이는 수단이지, 영향이 큰 database 변경의 책임을 없애는 수단이 아닙니다.

## patch·parameter 변경을 나눠 검증하기

upgrade 프로젝트에는 version 변경, RU(Release Update) 적용, optimizer parameter 변경, schema migration, application release가 함께 들어가기 쉽습니다. 모든 변경을 한 번에 넣고 replay하면 차이가 생겨도 원인을 분리하기 어렵습니다. 가능하면 baseline, database patch만 적용한 target, parameter를 바꾼 target, application release까지 포함한 target처럼 단계적 비교를 설계합니다. 현실적으로 모든 조합을 만들 수 없다면, 영향이 큰 변경부터 분리하고 나머지는 위험으로 기록합니다.

특히 optimizer 관련 설정은 전체 workload에 넓게 영향을 줄 수 있습니다. 과거 compatibility를 유지하려는 설정이 단기적으로 위험을 줄일 수도 있지만, 이를 영구 해결책으로 두면 새 version의 개선과 보안·지원 정책을 놓칠 수 있습니다. 어떤 SQL이 왜 달라졌는지 plan과 통계를 검토하고, SQL 수정·통계 개선·index 설계·SQL Plan Management 같은 선택지를 비교해야 합니다. parameter 하나로 모든 plan을 고정하는 접근은 다른 업무에 예기치 않은 비용을 만들 수 있습니다.

schema migration은 replay와 별도의 검증 질문을 가집니다. 열 추가처럼 확장 가능한 변경인지, backfill이 workload와 경쟁하는지, 이전 application version이 새 schema를 읽을 수 있는지, rollback 때 데이터 의미를 유지할 수 있는지 확인해야 합니다. replay target의 schema가 production과 다르다면, 그 차이를 성능 결과의 전제로 명시합니다. database change는 버전 업그레이드 하나가 아니라 데이터·SQL·application 계약이 함께 움직이는 변경입니다.

## 용량 계획과 장애 복구 관점

replay를 잘 통과해도 실제 운영의 용량 계획이 끝나는 것은 아닙니다. 과거 workload는 당시 트래픽과 데이터 크기의 표본이며, 사업 성장·신규 기능·계절성 이벤트는 더 큰 부하를 만들 수 있습니다. capacity planning에서는 앞으로의 트래픽 가정, data growth, backup·recovery window, batch window, HA failover 상황을 별도로 다룹니다. replay는 그 가정이 아닌 과거 실제 패턴을 보여 주는 한 가지 근거입니다.

또한 변경 배포 후의 관찰·되돌림 계획을 세워야 합니다. upgrade 직후 어떤 오류·wait event·업무 지표를 볼지, 심각한 회귀가 발견되면 application을 이전 database에 연결할 수 있는지 또는 restore·fallback 전략은 무엇인지, 되돌릴 수 없는 migration이 있는지 합의합니다. Database Replay는 배포 전에 위험을 줄이지만, zero-risk 배포를 만들어 주지는 않습니다. 실행 중인 system을 안전하게 관찰하고 대응하는 계획까지 있어야 검증 결과가 실제 운영 판단으로 이어집니다.

## 실험 결과를 팀의 지식으로 남기기

DBA만 replay 결과를 이해하는 구조는 위험합니다. 애플리케이션 팀은 어떤 transaction이 대표 workload였는지, 제품 책임자는 어떤 업무가 검증됐고 어떤 업무가 제외됐는지, 운영 팀은 배포 뒤 무엇을 관찰할지 알아야 합니다. 결과를 공유할 때는 database 내부 지표만 나열하기보다, "정산과 주문이 겹치는 구간을 재현했고 주문 완료·잔액 정합성은 통과했으며 특정 집계 SQL은 추가 tuning이 필요하다"처럼 업무 언어와 기술 근거를 연결합니다.

반대로 좋은 결과도 과장하지 않습니다. 캡처 날짜, target 환경 차이, 데이터 마스킹 범위, 포함하지 못한 외부 시스템, 미검증 시간대를 함께 적습니다. 이런 한계가 있어야 다음 release에서 새 workload를 추가하거나, release 후 관찰 범위를 넓히는 의사결정을 할 수 있습니다. 검증 문서는 승인을 위한 장식이 아니라 다음 변경을 더 안전하게 만드는 학습 기록입니다.

## 배포 뒤에는 가설을 다시 확인하기

replay에서 위험이 보이지 않았더라도 production 배포 뒤에는 같은 가설을 운영 지표로 확인해야 합니다. upgrade 전 기준선과 비교할 오류 코드, 핵심 transaction 성공률, batch 완료 시각, 주요 SQL의 경과 시간, lock·I/O 대기, connection pool 포화 여부를 정합니다. 관찰 기간에는 application release나 트래픽 이벤트처럼 결과를 바꿀 다른 변수를 함께 기록합니다. 이상이 생겼을 때 누가 어떤 dashboard와 log를 보고, 어느 조건에서 확장을 멈추거나 fallback을 시작할지도 미리 합의합니다.

이 단계는 replay가 틀렸다는 증명이 아니라 검증 범위를 이어 붙이는 과정입니다. test target에서 얻은 결과는 변경 전 의사결정을 돕고, production 관찰은 실제 환경에서 남은 불확실성을 줄입니다. 두 결과가 다르다면 숨기지 말고 데이터 분포, workload 변화, 인프라 차이, capture에 없던 경로를 조사해 다음 workload 선정과 runbook을 개선하세요.

## 한계와 적용 기준 Q&A

### Q. Database Replay만 하면 부하 테스트는 필요 없나요?

A. 아닙니다. Database Replay는 과거에 관찰한 database workload를 재현하는 데 강점이 있습니다. 신규 이벤트의 예상 트래픽, 모바일·웹 사용자 행동, CDN·API gateway·외부 provider를 포함한 전체 시스템의 한계는 별도의 부하·용량 테스트가 필요합니다. 두 도구는 입력과 답하는 질문이 다릅니다.

### Q. 작은 서비스도 반드시 Database Replay를 도입해야 하나요?

A. 아닙니다. workload가 단순하고 schema·parameter 변경이 작으며, 충분한 통합 테스트와 SQL 검토가 가능한 경우에는 준비 비용이 더 클 수 있습니다. upgrade 영향이 크고, 실제 동시성·batch·복잡한 SQL을 synthetic test로 표현하기 어렵고, 검증 환경을 안전하게 마련할 수 있을 때 우선순위를 검토하세요.

### Q. replay target의 데이터가 production보다 작아도 의미가 있나요?

A. 특정 호환성 오류나 workflow 문제를 찾는 데는 의미가 있을 수 있습니다. 하지만 data volume과 분포는 optimizer 계획, index 선택, sort, lock 경쟁에 영향을 주므로 성능 결과를 production과 동일하다고 해석하면 안 됩니다. 축소한 부분과 검증 가능한 범위를 명확히 적고, 중요한 대용량 SQL은 별도 계획으로 보완해야 합니다.

### Q. capture 파일에 민감 정보가 있는지 어떻게 판단하나요?

A. SQL text, bind 값, schema·object 이름, 사용자 식별자, 업무 키가 포함될 가능성을 기본 가정으로 두세요. 조직의 데이터 분류 기준과 보안 담당자의 검토를 받아 저장 위치·암호화·접근 권한·보관 기간·마스킹 여부를 정합니다. "테스트용 파일"이라는 이유만으로 보호 수준을 낮추면 안 됩니다.

## 마무리

Oracle Database Replay는 production을 복사해 보장하는 기능이 아니라, 실제 업무 패턴을 근거로 upgrade와 설정 변경의 위험을 더 구체적으로 검증하게 돕는 도구입니다. 대표 workload를 신중히 고르고, target을 안전하게 격리하며, source와 target의 차이를 기록하고, 오류·정합성·동시성·SQL 특성을 함께 분석하세요. 그러면 단순한 benchmark보다 배포 판단에 가까운 증거를 얻을 수 있으며, 동시에 replay가 보지 못하는 미래 변화와 시스템 경계도 과대평가하지 않게 됩니다.

<h3 class="references-heading">참고 자료</h3>

- [Oracle Database 23ai Real Application Testing User's Guide: Database Replay](https://docs.oracle.com/en/database/oracle/oracle-database/23/ratug/database-replay.html)
- [Oracle Database 23ai Real Application Testing User's Guide: SQL Performance Analyzer](https://docs.oracle.com/en/database/oracle/oracle-database/23/ratug/sql-performance-analyzer.html)
- [Oracle Database 23ai Performance Tuning Guide](https://docs.oracle.com/en/database/oracle/oracle-database/23/tgdba/)
- [Oracle Database Licensing Information User Manual](https://docs.oracle.com/en/database/oracle/oracle-database/23/dblic/)
