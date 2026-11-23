---
layout: post
title: "Oracle Partitioning을 설계하는 법: Range·Interval·Local Index·파티션 프루닝과 보관 정책"
categories: [DBA]
tags: [oracle, partitioning, interval-partition, partition-pruning, local-index, data-lifecycle, dba]
description: "Oracle Partitioning의 Range·List·Hash·Interval 방식과 파티션 프루닝, Local·Global Index, EXCHANGE·DROP 같은 유지보수 작업을 기반 개념부터 설명하고, 보관 정책과 성능 요구에 맞춰 파티션 키를 고르는 운영 기준을 정리합니다."
last_modified_at: 2026-11-23 12:00:00 +0900
---

## 먼저 답하기

### Q. 테이블이 커지면 일단 파티셔닝하면 빨라지나요?

A. 그렇지 않습니다. 파티셔닝은 큰 테이블을 여러 물리 조각(파티션)으로 나누되 애플리케이션에는 하나의 테이블처럼 보이게 하는 기능입니다. 조각으로 나눈다는 사실 자체가 SQL을 빠르게 만들지는 않습니다. 빨라지는 경우는 두 가지입니다. 하나는 SQL의 조건이 파티션 키와 맞아서 optimizer(실행 계획을 고르는 구성 요소)가 읽지 않아도 되는 파티션을 제외하는 경우(파티션 프루닝)이고, 다른 하나는 오래된 데이터를 `DROP PARTITION`처럼 파티션 단위 작업으로 한 번에 정리하여 대량 `DELETE`의 비용을 피하는 경우입니다. 이 두 가지가 필요한 업무가 아니라면 파티셔닝은 관리 대상만 늘리는 선택이 될 수 있습니다.

### Q. 어떤 파티션 방식과 키를 골라야 하나요?

A. 먼저 "가장 자주 쓰는 조회 조건"과 "데이터를 지우거나 보관하는 단위"를 적어 보세요. 거래 일자처럼 시간으로 쌓이고 월·일 단위로 보관하는 데이터는 Range 또는 Interval 파티션이 자연스럽습니다. 지역·상태처럼 값 목록으로 나뉘는 데이터는 List, 값이 고르게 흩어져야 하는 경우는 Hash가 후보입니다. 어느 쪽이든 키는 "WHERE 절에 자주 등장하고 범위가 좁혀지는 컬럼"이어야 합니다. 이 글은 Oracle Database 23ai 문서를 기준으로 개념과 실습 쿼리를 정리하며, 버전과 라이선스에 따라 가능한 기능이 다르므로 실제 환경에서는 공식 문서와 라이선스 계약을 확인해야 합니다.

## 먼저 알아둘 기반 기술

이 절은 본문에서 설명 없이 쓰이는 개념을 저장 구조라는 가장 밑바닥부터 파티셔닝 자체까지 순서대로 쌓아 올립니다. 뒤 소절은 앞 소절의 개념을 이용해 설명하므로 처음 접한다면 위에서부터 읽기를 권합니다. 각 소절 끝에 그 개념이 본문의 어느 절로 이어지는지 적었고, 섹션 마지막에 전체 연결 지도를 표로 정리했습니다.

### 테이블이 저장되는 방식: 블록, 세그먼트, 테이블스페이스, ROWID

Oracle Database(오라클 데이터베이스)는 관계형 데이터베이스 관리 시스템(RDBMS, Relational Database Management System), 즉 데이터를 행과 열로 이뤄진 표(테이블) 형태로 저장하고 SQL로 다루는 소프트웨어입니다. 테이블은 논리적인 이름일 뿐이고, 실제 데이터는 디스크의 블록(block, 보통 8KB 크기의 읽기·쓰기 최소 단위)에 저장됩니다. 하나의 테이블이나 인덱스가 차지하는 블록들의 묶음을 세그먼트(segment)라고 하고, 세그먼트를 담는 논리적 저장 공간을 테이블스페이스(tablespace)라고 합니다. 각 행에는 "어느 파일의 어느 블록의 몇 번째 칸"인지를 나타내는 물리 주소인 ROWID가 있습니다. 도서관에 비유하면 테이블은 "역사 분야"라는 분류, 세그먼트는 그 분류가 차지한 책장들, 테이블스페이스는 책장이 놓인 층, ROWID는 "3층 12번 책장 4번째 칸" 같은 위치표입니다.

```sql
SELECT segment_name, segment_type, tablespace_name, ROUND(bytes/1024/1024) AS size_mb
FROM   user_segments
WHERE  segment_name = 'ORDERS';
```

이 글에 이 개념이 필요한 이유는 파티셔닝의 본질이 "논리 테이블 하나를 여러 세그먼트로 나눠 저장하는 것"이기 때문입니다. 세그먼트를 모르면 파티션을 통째로 지우거나 다른 테이블스페이스로 옮기는 작업이 왜 빠른지, 파티션 키를 바꾸면 왜 ROWID가 바뀌는지 이해하기 어렵습니다. 이 개념은 아래 「파티션 유지보수: 보관 정책을 파티션 작업으로 바꾸기」 절에서 `EXCHANGE`·`MOVE PARTITION`이 빠른 이유로, 「성능 영향과 한계 이해하기」 절에서 행 이동과 ROWID 변경으로, 「운영 점검 쿼리 모음」 절에서 `USER_SEGMENTS`로 파티션별 크기를 보는 근거로, 「업무 규칙과 파티션 설계 연결하기」 절에서 읽기 전용 테이블스페이스 전략으로 쓰입니다.

### DML·DDL과 undo·redo, 잠금

SQL 명령은 크게 두 종류입니다. DML(Data Manipulation Language, 데이터 조작어)은 `INSERT`, `UPDATE`, `DELETE`처럼 행을 바꾸는 명령이고, DDL(Data Definition Language, 데이터 정의어)은 `CREATE`, `ALTER`, `DROP`처럼 구조를 바꾸는 명령입니다. Oracle은 DML을 실행할 때 두 가지 기록을 남깁니다. undo는 "바꾸기 전 값"으로, 롤백(변경 취소)과 다른 세션의 일관된 읽기에 쓰입니다. redo는 "무엇을 바꿨는지"의 기록으로, 장애가 나면 이 기록을 다시 적용해 데이터를 복구합니다. 또 같은 데이터를 여러 세션이 동시에 바꾸지 못하도록 잠금(lock)을 겁니다. 가계부에 비유하면 undo는 고치기 전 금액을 적어 둔 메모, redo는 "몇 시에 무엇을 고쳤다"는 변경 일지입니다.

```sql
-- 1억 건 중 1년 치를 행 단위로 지우면 지운 행마다 undo와 redo가 생긴다
DELETE FROM orders WHERE order_date < DATE '2025-01-01';
```

이 개념이 필요한 이유는 파티셔닝을 도입하는 가장 큰 운영상 이유가 "대량 `DELETE`의 undo·redo 비용을 파티션 단위 DDL로 피하는 것"이기 때문입니다. 반대로 DDL은 롤백으로 되돌릴 수 없어 실수하면 백업이나 Flashback(과거 시점의 데이터로 되돌리는 Oracle 기능)에 기대야 하고, 잠금 범위가 넓을 수 있다는 점도 함께 알아야 안전한 작업 계획을 세울 수 있습니다. 이 개념은 아래 「파티션 유지보수: 보관 정책을 파티션 작업으로 바꾸기」 절에서 `DROP PARTITION`과 `DELETE`의 비교로, 「도입 절차: 기존 테이블을 파티션으로 바꾸기」 절에서 롤백 절차 문서화로, 「팀 운영 체크리스트」 절에서 DML·DDL 잠금 영향 확인 항목으로 쓰입니다.

### B-tree 인덱스와 유일 제약

인덱스(index)는 책 뒤의 찾아보기처럼 "어떤 값이 어느 ROWID에 있는가"를 정렬해 둔 별도 구조입니다. Oracle의 기본 인덱스는 B-tree(균형 트리)로, 루트에서 시작해 몇 단계 가지를 내려가면 원하는 값의 ROWID를 찾을 수 있습니다. 백만 건 테이블이라도 보통 3~4단계만 내려가면 되므로 전체를 훑는 것보다 훨씬 적게 읽습니다. 유일 제약(unique constraint)은 "이 컬럼 값은 중복될 수 없다"는 규칙이고, Oracle은 보통 유일 인덱스로 이를 검사합니다. 새 값을 넣을 때 인덱스에서 같은 값이 있는지 찾아보는 방식입니다. 한 가지 주의할 점은 인덱스가 컬럼의 원래 값을 정렬해 둔 것이므로, `TO_CHAR(order_date, ...)`처럼 컬럼에 함수를 씌운 조건으로는 일반 인덱스를 그대로 활용하기 어렵다는 것입니다.

```sql
CREATE UNIQUE INDEX ux_orders_id ON orders (order_id);
-- 같은 order_id를 다시 넣으면 ORA-00001(유일 제약 위반)이 발생
```

이 개념이 필요한 이유는 파티션 테이블에서 인덱스를 "파티션마다 나눌지, 전체에 하나만 둘지"를 결정해야 하는데, 그 판단이 인덱스 탐색 횟수와 유일성 검사 방식에 달려 있기 때문입니다. 인덱스 조각이 여러 개면 유일성을 왜 바로 확인할 수 없는지, 파티션이 36개면 왜 탐색이 36번 일어나는지가 B-tree 구조에서 나옵니다. 이 개념은 아래 「파티션 프루닝이 되는지 확인하는 법」 절에서 함수를 씌운 조건의 문제로, 「Local Index와 Global Index 선택하기」 절에서 Local Unique Index 조건으로, 「성능 영향과 한계 이해하기」 절에서 파티션 수만큼 늘어나는 인덱스 탐색으로 쓰입니다.

### 옵티마이저, 실행 계획, 바인드 변수, 통계

옵티마이저(optimizer)는 SQL을 받아 "어떤 순서로, 인덱스를 쓸지 전체를 훑을지" 같은 실행 방법을 고르는 구성 요소이고, 그 결과물이 실행 계획(execution plan)입니다. 내비게이션이 출발지와 목적지를 보고 경로를 고르는 것과 비슷합니다. 실행 계획에서 `TABLE ACCESS FULL`은 대상 세그먼트를 처음부터 끝까지 읽는다는 뜻입니다. 옵티마이저는 경로를 고를 때 통계(statistics), 즉 테이블의 행 수·값 분포 같은 요약 정보를 참고하며, 통계가 오래되면 잘못된 경로를 고를 수 있습니다. 바인드 변수(bind variable)는 SQL 문장에 값을 직접 쓰지 않고 `:d1`처럼 자리만 두었다가 실행할 때 값을 넣는 방식입니다. 같은 문장을 재사용할 수 있지만, 계획을 세우는 시점에는 실제 값을 모를 수 있습니다.

```sql
EXPLAIN PLAN FOR SELECT * FROM orders WHERE order_id = :id;
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY);
```

이 개념이 필요한 이유는 파티션 프루닝이 옵티마이저가 실행 계획을 세울 때 일어나는 일이기 때문입니다. 실행 계획을 읽을 줄 모르면 프루닝이 됐는지 확인할 방법이 없고, 바인드 변수를 모르면 `Pstart`에 숫자 대신 `KEY`가 나오는 이유를 오해하게 됩니다. 통계를 모르면 `NUM_ROWS`가 비어 있는 이유나 `LAST_ANALYZED`를 점검하는 이유도 설명되지 않습니다. 이 개념은 아래 「파티션 프루닝이 되는지 확인하는 법」 절에서 `DBMS_XPLAN`과 `KEY` 표기로, 「성능 영향과 한계 이해하기」 절에서 파티션 통계 수집으로, 「파티션 도입 후 첫 한 달의 점검 흐름」 절에서 `LAST_ANALYZED` 점검으로 쓰입니다.

### 데이터 딕셔너리 뷰

데이터 딕셔너리(data dictionary)는 데이터베이스가 스스로에 대해 기록해 둔 메타데이터 저장소입니다. 어떤 테이블이 있고, 어떤 컬럼과 인덱스가 있으며, 각 파티션의 경계값이 무엇인지가 여기에 들어 있습니다. 사용자는 이를 `USER_`, `ALL_`, `DBA_`로 시작하는 뷰(view, 저장된 조회문)로 조회합니다. `USER_`는 내 소유 객체, `ALL_`은 내가 접근할 수 있는 객체, `DBA_`는 데이터베이스 전체 객체를 보여 줍니다. 건물에 비유하면 각 층의 방 배치와 용도를 적어 둔 관리 대장입니다.

```sql
SELECT table_name, partitioned, num_rows, last_analyzed
FROM   user_tables
WHERE  table_name = 'ORDERS';
```

이 개념이 필요한 이유는 파티션 구조 확인, 인덱스 상태 점검, 자동 생성 파티션 추적처럼 이 글의 진단 쿼리가 거의 모두 딕셔너리 뷰를 조회하기 때문입니다. 또 `EXCHANGE PARTITION`이 데이터를 옮기지 않고 "딕셔너리의 소속만 바꾼다"는 설명도 딕셔너리를 알아야 이해됩니다. 이 개념은 아래 「업무 예시: 주문 이력 테이블의 월별 파티셔닝」 절에서 `USER_PART_TABLES`·`USER_TAB_PARTITIONS` 조회로, 「운영 점검 쿼리 모음」 절에서 정기 점검 쿼리로, 「파티션 도입 후 첫 한 달의 점검 흐름」 절에서 주간 점검 쿼리로 쓰입니다.

### 파티셔닝이 무엇이고 왜 등장했는가

테이블에 수억 건이 쌓이면 세 가지 어려움이 생깁니다. 첫째, 조회할 때 필요한 기간이 일부인데도 전체를 훑을 수 있습니다. 둘째, 오래된 데이터를 지우려고 `DELETE`를 실행하면 앞 소절에서 본 undo와 redo가 대량으로 생기고 시간이 오래 걸립니다. 셋째, 백업·통계 수집·인덱스 재구성처럼 테이블 전체를 대상으로 하는 관리 작업이 점점 길어집니다. Oracle Partitioning(파티셔닝)은 이 문제를 줄이기 위해 하나의 논리 테이블을 여러 파티션으로 나누고, 파티션마다 별도의 세그먼트로 관리하는 기능입니다. 사용자는 같은 테이블 이름으로 `SELECT`와 `INSERT`를 하고, 데이터베이스가 행을 알맞은 파티션에 배치합니다. 서류함에 비유하면 한 서랍에 모든 서류를 넣는 대신 월별 칸막이를 두어, 3월 서류만 꺼내거나 작년 칸을 통째로 비울 수 있게 하는 것입니다.

한 가지 주의할 점이 있습니다. Partitioning은 Oracle Database Enterprise Edition에서 별도 라이선스가 필요한 옵션으로 제공되는 기능입니다. 개발 환경에서 되던 `CREATE TABLE ... PARTITION BY`가 운영 환경에서는 라이선스나 에디션 때문에 허용되지 않을 수 있습니다. 설계 문서를 쓰기 전에 사용할 에디션과 옵션 보유 여부를 확인하세요. 이 글은 라이선스 판단을 대신하지 않습니다. 이 개념은 아래 「업무 예시: 주문 이력 테이블의 월별 파티셔닝」 절에서 보관 정책이 있는 주문 이력 테이블로, 「도입 절차: 기존 테이블을 파티션으로 바꾸기」 절에서 전환 여부 판단으로, 「업무 규칙과 파티션 설계 연결하기」 절에서 보관 기간과 설계의 연결로 쓰입니다.

### 파티션 키와 파티션 방식

파티션 키(partition key)는 행이 어느 파티션으로 가는지를 정하는 컬럼입니다. 우편물 분류에 비유하면 우편번호가 파티션 키이고, "앞자리 범위로 나눌지, 지역 목록으로 나눌지, 고르게 섞어 나눌지"가 파티션 방식입니다. 예를 들어 `order_date`가 `2026-03-15`인 행은 월별 Range 파티션에서 3월 파티션으로 갑니다. 키 값과 파티션 방식에 따라 다음과 같이 나뉩니다.

| 방식 | 나누는 기준 | 대표 용도 | 주의할 점 |
| --- | --- | --- | --- |
| Range | 값의 범위(예: 월) | 시계열 데이터, 보관 기간 관리 | 새 기간용 파티션을 미리 만들어야 함 |
| Interval | Range에 자동 생성 규칙을 더한 것 | 월·일 단위로 계속 쌓이는 데이터 | 간격 규칙과 시작 파티션이 필요함 |
| List | 값 목록(예: 지역 코드) | 지역·상태·고객군 분리 | 목록에 없는 값 처리(DEFAULT) 필요 |
| Hash | 키의 해시값 | 부하·저장 분산, 파티션 단위 병렬 처리 | 범위 조회 프루닝에는 도움이 안 됨 |
| Composite | 위 방식의 조합(예: Range-Hash) | 시간 보관과 분산을 함께 요구할 때 | 파티션 수가 곱으로 늘어남 |

여기서 Range는 "작은 값부터 경계값 미만"처럼 구간을 지정하고, Interval은 Range의 확장으로 정해진 간격(예: 1개월)에 해당하는 데이터가 처음 들어올 때 파티션을 자동으로 만들어 줍니다. Hash의 해시(hash)는 값을 정해진 규칙으로 섞어 고른 번호로 바꾸는 계산이라, 비슷한 값끼리 모이지 않고 흩어집니다. 그 외에도 부모 테이블의 파티션 구조를 자식 테이블이 따르는 Reference 파티션, 값이 들어오면 List 파티션을 자동 생성하는 Auto-List 같은 방식이 있으나, 이 글은 가장 보편적인 Range·Interval 중심으로 설명합니다. 키를 잘못 고르면 이후의 모든 이점이 사라지므로 이 소절이 본문 설계 판단의 출발점입니다. 이 개념은 아래 「업무 예시: 주문 이력 테이블의 월별 파티셔닝」 절에서 Range·Interval 테이블 생성으로, 「Hash와 List 파티션을 쓰는 상황」 절에서 다른 방식의 예제로, 「비교: 파티션 방식별 선택 기준」 절에서 방식 선택 질문으로 쓰입니다.

### 파티션 프루닝이 무엇인가

파티션 프루닝(partition pruning)은 SQL의 조건을 보고 읽지 않아도 되는 파티션을 실행 계획 단계에서 제외하는 동작입니다. 예를 들어 월별 Range 파티션 테이블에서 `order_date`가 3월인 주문만 조회한다면, optimizer는 3월 파티션 하나만 읽겠다고 계획을 세울 수 있습니다. 이때 실행 계획의 `Pstart`, `Pstop` 열이 읽기 시작·종료 파티션 번호를 알려 줍니다. 이 열이 `KEY`로 나오면 실행 시점에 값이 정해진다는 뜻이고, 숫자로 나오면 계획 단계에서 이미 파티션이 정해졌다는 뜻입니다. 전체 파티션을 읽으면 `1`부터 마지막 번호까지, 또는 `ALL`처럼 보입니다. 서류함 비유로 돌아가면, "3월 서류를 찾는다"는 요청을 받고 다른 칸막이는 열어 보지도 않는 것입니다.

프루닝은 앞에서 본 파티션 키와 옵티마이저가 만나는 지점입니다. 조건이 파티션 키에 직접 걸려 있어야 옵티마이저가 파티션 경계와 비교할 수 있고, 키에 함수를 씌우거나 키 조건이 아예 없으면 모든 파티션을 읽습니다. 파티셔닝으로 조회가 빨라지는 경우는 대부분 이 동작 덕분이므로, 프루닝을 확인하지 않고는 성능 이득을 말할 수 없습니다. 이 개념은 아래 「파티션 프루닝이 되는지 확인하는 법」 절에서 실행 계획의 Pstart·Pstop 확인으로, 「성능 영향과 한계 이해하기」 절에서 프루닝만 믿으면 안 되는 경우로, 「흔한 실수와 회피 방법」 절에서 파티션 키에 함수를 적용하는 실수로 쓰입니다.

### Local Index와 Global Index

인덱스도 파티션에 맞춰 설계할 수 있습니다. Local Index는 테이블 파티션과 1:1로 대응하도록 인덱스가 나뉜 것이고, Global Index는 테이블 파티션 구조와 독립적으로 만들어진 인덱스입니다. 서류함 비유로는 Local Index가 칸막이마다 붙인 작은 색인표, Global Index가 서류함 전체에 대한 큰 색인 장부입니다. 차이는 유지보수에서 크게 드러납니다. Local Index는 파티션을 추가하거나 `DROP`할 때 해당 파티션의 인덱스 조각만 따라 움직입니다. 반면 Global Index는 파티션을 `DROP`하면 그 안의 행을 가리키던 인덱스 엔트리를 처리해야 하므로, 기본 상태에서는 인덱스가 `UNUSABLE`이 될 수 있고, `UPDATE INDEXES` 절을 쓰면 인덱스를 유지하는 대신 작업이 오래 걸릴 수 있습니다.

이 차이를 모르면 "월말 정리 작업은 5초면 끝난다"는 계획이 "인덱스 재구성으로 몇 시간"이 되는 사고로 이어집니다. 또 앞에서 본 B-tree 인덱스와 유일 제약 개념을 여기에 대입하면, Local Index는 조각끼리 서로를 모르므로 파티션 키를 포함하지 않으면 전체 유일성을 검사할 수 없다는 결론이 나옵니다. 이 개념은 아래 「Local Index와 Global Index 선택하기」 절에서 비교 표와 생성·점검 쿼리로, 「파티션 유지보수: 보관 정책을 파티션 작업으로 바꾸기」 절에서 `UPDATE INDEXES` 선택으로, 「흔한 실수와 회피 방법」 절에서 Global Index를 `UNUSABLE`로 방치하는 실수로, 「팀 운영 체크리스트」 절에서 영향받는 인덱스 확인 항목으로 쓰입니다.

아래 표는 지금까지 본 기반 개념이 본문의 어느 절에서 어떤 역할로 다시 쓰이는지를 한눈에 정리한 연결 지도입니다.

| 기반 개념 | 쓰이는 본문 절 | 그 절에서의 역할 |
| --- | --- | --- |
| 블록·세그먼트·테이블스페이스·ROWID | 파티션 유지보수: 보관 정책을 파티션 작업으로 바꾸기 | `EXCHANGE`·`MOVE PARTITION`이 빠른 이유 |
| 블록·세그먼트·테이블스페이스·ROWID | 성능 영향과 한계 이해하기 | 행 이동 시 ROWID 변경 |
| 블록·세그먼트·테이블스페이스·ROWID | 운영 점검 쿼리 모음 | `USER_SEGMENTS`로 파티션별 크기 확인 |
| 블록·세그먼트·테이블스페이스·ROWID | 업무 규칙과 파티션 설계 연결하기 | 읽기 전용 테이블스페이스와 저장소 계층 |
| DML·DDL과 undo·redo, 잠금 | 파티션 유지보수: 보관 정책을 파티션 작업으로 바꾸기 | `DROP PARTITION`과 대량 `DELETE` 비교 |
| DML·DDL과 undo·redo, 잠금 | 도입 절차: 기존 테이블을 파티션으로 바꾸기 | 전환 방식과 롤백 절차 |
| DML·DDL과 undo·redo, 잠금 | 팀 운영 체크리스트 | DML·DDL 잠금 영향 확인 |
| B-tree 인덱스와 유일 제약 | 파티션 프루닝이 되는지 확인하는 법 | 함수를 씌운 조건의 문제 |
| B-tree 인덱스와 유일 제약 | Local Index와 Global Index 선택하기 | Local Unique Index의 파티션 키 포함 조건 |
| B-tree 인덱스와 유일 제약 | 성능 영향과 한계 이해하기 | 파티션 수만큼 늘어나는 인덱스 탐색 |
| 옵티마이저·실행 계획·바인드 변수·통계 | 파티션 프루닝이 되는지 확인하는 법 | `DBMS_XPLAN`, Pstart·Pstop, `KEY` 표기 |
| 옵티마이저·실행 계획·바인드 변수·통계 | 성능 영향과 한계 이해하기 | 파티션 통계 수집 |
| 옵티마이저·실행 계획·바인드 변수·통계 | 파티션 도입 후 첫 한 달의 점검 흐름 | `LAST_ANALYZED`와 대표 SQL 계획 재확인 |
| 데이터 딕셔너리 뷰 | 업무 예시: 주문 이력 테이블의 월별 파티셔닝 | `USER_PART_TABLES`·`USER_TAB_PARTITIONS` 조회 |
| 데이터 딕셔너리 뷰 | 운영 점검 쿼리 모음 | 자동 생성 파티션 수 추적 |
| 데이터 딕셔너리 뷰 | 파티션 도입 후 첫 한 달의 점검 흐름 | 주간 점검 쿼리 |
| 파티셔닝이 무엇이고 왜 등장했는가 | 업무 예시: 주문 이력 테이블의 월별 파티셔닝 | 보관 정책이 있는 대용량 테이블 사례 |
| 파티셔닝이 무엇이고 왜 등장했는가 | 도입 절차: 기존 테이블을 파티션으로 바꾸기 | 전환 필요성 판단과 검증 계획 |
| 파티셔닝이 무엇이고 왜 등장했는가 | 업무 규칙과 파티션 설계 연결하기 | 보관 기간과 설계의 연결 |
| 파티션 키와 파티션 방식 | 업무 예시: 주문 이력 테이블의 월별 파티셔닝 | Range·Interval 테이블 생성 |
| 파티션 키와 파티션 방식 | Hash와 List 파티션을 쓰는 상황 | Hash·List·Composite 예제 |
| 파티션 키와 파티션 방식 | 비교: 파티션 방식별 선택 기준 | 방식 선택 질문표 |
| 파티션 프루닝이 무엇인가 | 파티션 프루닝이 되는지 확인하는 법 | 프루닝 되는 SQL과 안 되는 SQL |
| 파티션 프루닝이 무엇인가 | 성능 영향과 한계 이해하기 | 프루닝만 믿으면 안 되는 경우 |
| 파티션 프루닝이 무엇인가 | 흔한 실수와 회피 방법 | 파티션 키에 함수 적용 실수 |
| Local Index와 Global Index | Local Index와 Global Index 선택하기 | 비교 표, 생성·상태 점검 쿼리 |
| Local Index와 Global Index | 파티션 유지보수: 보관 정책을 파티션 작업으로 바꾸기 | `UPDATE INDEXES` 선택 |
| Local Index와 Global Index | 흔한 실수와 회피 방법 | Global Index UNUSABLE 방치 |
| Local Index와 Global Index | 팀 운영 체크리스트 | 영향받는 인덱스 확인 |

## 업무 예시: 주문 이력 테이블의 월별 파티셔닝

가상의 쇼핑몰 주문 이력 `ORDERS`를 예로 들겠습니다. 이 테이블에는 매월 수백만 건이 쌓이고, 운영팀은 "최근 3개월 주문은 자주 조회, 13개월이 지난 주문은 보관 시스템으로 이관 후 삭제"라는 정책을 갖고 있다고 가정합니다. 앞서 기반 기술에서 본 파티셔닝의 두 이점, 곧 프루닝과 파티션 단위 정리가 모두 필요한 전형적인 경우입니다. 아래 수치는 설명용 가정이며 실제로 측정한 값이 아닙니다.

### Range 파티션 테이블 만들기

```sql
CREATE TABLE orders (
  order_id     NUMBER        NOT NULL,
  customer_id  NUMBER        NOT NULL,
  order_date   DATE          NOT NULL,
  status       VARCHAR2(20)  NOT NULL,
  amount       NUMBER(12,2)  NOT NULL
)
PARTITION BY RANGE (order_date)
(
  PARTITION p_2026_01 VALUES LESS THAN (DATE '2026-02-01'),
  PARTITION p_2026_02 VALUES LESS THAN (DATE '2026-03-01'),
  PARTITION p_2026_03 VALUES LESS THAN (DATE '2026-04-01'),
  PARTITION p_max     VALUES LESS THAN (MAXVALUE)
);
```

앞서 기반 기술에서 본 Range 방식대로 `VALUES LESS THAN`은 "이 값 미만"을 뜻하므로 `p_2026_01`에는 2026년 1월 1일부터 1월 31일까지의 행이 들어갑니다. 마지막 `MAXVALUE` 파티션은 어느 경계에도 속하지 않는 값을 받아 주는 안전망입니다. 다만 이 안전망에 계속 데이터가 쌓이도록 방치하면 파티셔닝의 이점이 사라지므로, 새 기간 파티션을 만드는 절차가 필요합니다.

### Interval 파티션으로 자동 생성하기

매달 새 파티션을 손으로 만드는 일은 잊기 쉽습니다. Interval 파티션은 이 작업을 줄입니다.

```sql
CREATE TABLE orders_i (
  order_id     NUMBER        NOT NULL,
  customer_id  NUMBER        NOT NULL,
  order_date   DATE          NOT NULL,
  status       VARCHAR2(20)  NOT NULL,
  amount       NUMBER(12,2)  NOT NULL
)
PARTITION BY RANGE (order_date)
INTERVAL (NUMTOYMINTERVAL(1, 'MONTH'))
(
  PARTITION p_init VALUES LESS THAN (DATE '2026-01-01')
);
```

`p_init`보다 큰 값이 처음 들어오면 Oracle이 해당 월의 파티션을 자동으로 만듭니다. 자동 생성된 파티션은 `SYS_P123`처럼 시스템이 정한 이름을 받기 때문에 이름을 정리하는 규칙을 따로 정하는 편이 좋습니다. 또한 Interval 파티션 방식에서는 시작점이 되는 Range 파티션이 최소 하나 있어야 하며, 파티션 키 컬럼의 타입이 `NUMBER`나 `DATE` 계열 같은 허용 타입이어야 합니다. 허용 타입과 제약은 버전별 문서를 확인하세요.

### 현재 파티션 구조 조회하기

설계가 끝나면 앞서 기반 기술에서 본 데이터 딕셔너리 뷰로 실제 구조를 확인합니다. 아래 쿼리는 그대로 돌려볼 수 있는 진단 쿼리입니다.

```sql
SELECT table_name, partitioning_type, interval, partition_count
FROM   user_part_tables
WHERE  table_name IN ('ORDERS', 'ORDERS_I');

SELECT table_name, partition_name, high_value, interval, num_rows
FROM   user_tab_partitions
WHERE  table_name = 'ORDERS_I'
ORDER  BY partition_position;
```

`USER_PART_TABLES`에서는 테이블이 어떤 방식으로 나뉘었는지, `USER_TAB_PARTITIONS`에서는 파티션별 경계값(`HIGH_VALUE`)과 Interval 자동 생성 여부(`INTERVAL` 열이 `YES`)를 볼 수 있습니다. `NUM_ROWS`는 앞서 기반 기술에서 본 옵티마이저 통계가 수집된 경우에만 값이 채워지므로, 비어 있다면 통계를 아직 수집하지 않은 상태일 수 있습니다. `HIGH_VALUE`는 `LONG` 타입이어서 `WHERE` 조건으로 걸러내기 불편하다는 점도 알아 두세요.

## 파티션 프루닝이 되는지 확인하는 법

### 프루닝이 되는 SQL과 안 되는 SQL

앞서 기반 기술에서 본 파티션 프루닝 관점에서 보면, 다음 두 SQL은 얼핏 같은 의미지만 프루닝 가능성이 다릅니다.

```sql
-- 파티션 키에 직접 범위 조건을 쓴 경우
SELECT /* q_range */ COUNT(*), SUM(amount)
FROM   orders
WHERE  order_date >= DATE '2026-03-01'
AND    order_date <  DATE '2026-04-01';

-- 파티션 키에 함수를 씌운 경우
SELECT /* q_func */ COUNT(*), SUM(amount)
FROM   orders
WHERE  TO_CHAR(order_date, 'YYYY-MM') = '2026-03';
```

첫 번째 SQL은 컬럼이 변형되지 않아 optimizer가 3월 경계와 직접 비교할 수 있습니다. 두 번째 SQL은 각 행의 날짜를 문자열로 바꾼 뒤 비교하므로, 파티션 경계와 조건을 직접 대응시키기 어려워 프루닝이 되지 않을 수 있습니다. 앞서 기반 기술에서 본 B-tree 인덱스에서 인덱스 컬럼에 함수를 씌우면 일반 인덱스를 못 쓰는 문제와 비슷한 패턴입니다. 해결은 단순합니다. 조건을 `>=`와 `<`로 풀어 쓰고, 월 단위 입력을 받으면 애플리케이션이 시작일과 다음 달 시작일을 계산해서 바인드 변수로 전달하세요.

### 실행 계획에서 Pstart와 Pstop 읽기

앞서 기반 기술에서 본 실행 계획은 다음 명령으로 확인합니다.

```sql
EXPLAIN PLAN FOR
SELECT COUNT(*), SUM(amount)
FROM   orders
WHERE  order_date >= DATE '2026-03-01'
AND    order_date <  DATE '2026-04-01';

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(format => 'BASIC +PARTITION'));
```

출력 형식은 아래처럼 나옵니다. 이 결과는 읽는 방법을 보여 주기 위한 예시이며 특정 환경에서 측정한 값이 아닙니다.

```text
-------------------------------------------------------------
| Id  | Operation              | Name   | Pstart| Pstop |
-------------------------------------------------------------
|   0 | SELECT STATEMENT       |        |       |       |
|   1 |  SORT AGGREGATE        |        |       |       |
|   2 |   PARTITION RANGE SINGLE|       |     3 |     3 |
|   3 |    TABLE ACCESS FULL   | ORDERS |     3 |     3 |
-------------------------------------------------------------
```

`PARTITION RANGE SINGLE`은 단일 파티션만 읽는다는 뜻이고, `Pstart`와 `Pstop`이 둘 다 3이므로 세 번째 파티션만 읽습니다. 전체를 읽는 계획이라면 `PARTITION RANGE ALL`처럼 나옵니다. `TABLE ACCESS FULL`이라고 해서 곧바로 나쁜 계획은 아닙니다. 하나의 파티션 안에서 풀 스캔을 한다면 전체 테이블이 아니라 해당 파티션만 훑는 것이기 때문입니다. 읽는 데이터 양과 비교해서 판단해야 합니다.

### 바인드 변수와 KEY 표기

앞서 기반 기술에서 본 바인드 변수를 쓰면 `Pstart`와 `Pstop`에 `KEY`가 나올 수 있습니다.

```sql
VAR d1 VARCHAR2(10)
VAR d2 VARCHAR2(10)
EXEC :d1 := '2026-03-01'; :d2 := '2026-04-01';

EXPLAIN PLAN FOR
SELECT COUNT(*)
FROM   orders
WHERE  order_date >= TO_DATE(:d1, 'YYYY-MM-DD')
AND    order_date <  TO_DATE(:d2, 'YYYY-MM-DD');

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(format => 'BASIC +PARTITION'));
```

바인드 값은 실행 시점에 정해지므로 계획 시점에는 어느 파티션인지 확정되지 않아 `KEY`로 표기되고, 실제 실행할 때 프루닝이 일어납니다. `KEY`는 문제가 아니라 "실행 시점 프루닝"을 뜻하는 표기입니다. 다만 바인드 값에 따라 읽는 파티션 수가 크게 달라질 수 있으므로, 월 단위 조회와 연 단위 조회가 같은 SQL 문장에 섞이지 않도록 업무를 나누는 것이 좋습니다.

## Local Index와 Global Index 선택하기

### 기본 비교

| 구분 | Local Index | Global Index (비파티션) |
| --- | --- | --- |
| 구조 | 테이블 파티션과 1:1 | 테이블 전체에 하나 |
| 파티션 DROP 시 | 해당 조각만 제거 | 엔트리 정리 필요, UPDATE INDEXES 고려 |
| 프루닝 시 이점 | 읽는 파티션의 인덱스만 사용 | 전체 인덱스를 탐색 |
| 유일성 보장 | 파티션 키를 포함해야 가능 | 키 단독 유일성 보장 가능 |
| 적합 | 시간 기반 조회, 보관 정책 | 파티션 키 없이 단건 조회하는 키 |

앞서 기반 기술에서 본 Local Index와 Global Index의 구조 차이 가운데 설계에 가장 큰 영향을 주는 것은 유일성입니다. Local Unique Index는 인덱스 키에 파티션 키가 포함되어야 합니다. 그렇지 않으면 서로 다른 파티션의 인덱스 조각끼리 중복 여부를 확인할 수 없기 때문입니다. 따라서 `order_id`만으로 유일성을 보장하고 싶다면 비파티션 Global Index나 Global Partitioned Index가 필요하고, 그만큼 파티션 유지보수 때 인덱스 영향을 감수해야 합니다. 이 선택은 업무 규칙에서 나옵니다. "주문번호는 날짜와 무관하게 전체에서 유일해야 한다"는 규칙이라면 번호 자체에 날짜가 들어가도록 설계하거나, 유일 제약을 어디서 보장할지 결정해야 합니다.

### Local Index 생성 예시

```sql
CREATE INDEX ix_orders_cust_date
  ON orders (customer_id, order_date)
  LOCAL;

CREATE UNIQUE INDEX ux_orders_id_date
  ON orders (order_id, order_date)
  LOCAL;
```

첫 번째는 특정 고객의 기간별 주문 조회를 돕는 Local Index이고, 두 번째는 `order_date`를 포함해서 Local Unique Index 조건을 만족합니다. 단, 두 번째 인덱스는 `order_id`만의 유일성을 보장하지 않으므로, 애플리케이션이 `order_id`를 시퀀스로 발급해 중복을 막고 있다는 전제를 문서화해야 합니다.

### 인덱스 상태 점검

```sql
SELECT i.index_name, i.status, p.partition_name, p.status AS part_status
FROM   user_indexes i
LEFT   JOIN user_ind_partitions p ON p.index_name = i.index_name
WHERE  i.table_name = 'ORDERS'
ORDER  BY i.index_name, p.partition_position;
```

파티션 유지보수를 한 뒤에는 이 쿼리로 `UNUSABLE` 상태가 남았는지 확인합니다. `STATUS`가 `N/A`로 나오는 것은 파티션 인덱스의 경우 상위 `STATUS` 대신 파티션 단위 상태를 봐야 한다는 뜻이므로 정상일 수 있습니다. 실제로 `UNUSABLE`이 보이면 해당 인덱스 파티션을 `REBUILD`하거나, 유지보수 시 `UPDATE INDEXES` 옵션을 사용할지 계획에 반영해야 합니다.

## 파티션 유지보수: 보관 정책을 파티션 작업으로 바꾸기

### 주요 작업과 의미

파티셔닝의 가장 큰 운영 가치는 데이터 수명 주기를 파티션 작업으로 바꾸는 데 있습니다.

| 작업 | 설명 | 흔한 사용처 |
| --- | --- | --- |
| ADD PARTITION | 새 파티션 추가 | 다음 달 파티션 준비 |
| DROP PARTITION | 파티션과 데이터를 삭제 | 보관 기간이 지난 데이터 정리 |
| TRUNCATE PARTITION | 데이터만 비움 | 임시 적재 영역 초기화 |
| SPLIT PARTITION | 파티션을 둘로 분할 | MAXVALUE 파티션 정리 |
| MERGE PARTITIONS | 인접 파티션을 합침 | 오래된 월을 분기·연 단위로 통합 |
| EXCHANGE PARTITION | 파티션과 일반 테이블을 교환 | 적재·보관 이관, 검증 후 교체 |
| MOVE PARTITION | 파티션을 다른 테이블스페이스로 이동 | 저장소 계층 이동 |

`DROP PARTITION`은 `DELETE`와 비교할 때 앞서 기반 기술에서 본 undo와 redo가 크게 줄어드는 대신, 되돌릴 수 없다는 점을 먼저 인식해야 합니다. 실수로 잘못된 파티션을 지우면 복구는 백업이나 Flashback 기능에 의존합니다. 그래서 삭제 전에 `EXCHANGE PARTITION`으로 보관용 테이블에 옮기는 절차를 두는 팀도 있습니다.

### 월별 파티션 정리 절차 예시

```sql
-- 1) 지울 후보 파티션 확인
SELECT partition_name, high_value
FROM   user_tab_partitions
WHERE  table_name = 'ORDERS'
ORDER  BY partition_position;

-- 2) 보관용 빈 테이블과 교환 (구조가 같아야 함)
CREATE TABLE orders_arch_2026_01 FOR EXCHANGE WITH TABLE orders;

ALTER TABLE orders
  EXCHANGE PARTITION p_2026_01 WITH TABLE orders_arch_2026_01
  INCLUDING INDEXES WITHOUT VALIDATION;

-- 3) 교환 후 비어 있는 파티션 제거 (Global Index 영향 확인)
ALTER TABLE orders DROP PARTITION p_2026_01 UPDATE INDEXES;
```

앞서 기반 기술에서 본 세그먼트 개념으로 보면, `EXCHANGE PARTITION`은 데이터 블록을 복사하지 않고 딕셔너리에 기록된 세그먼트의 소속만 바꾸기 때문에 빠릅니다. 단, 교환 대상 테이블은 구조가 같아야 하고, `WITHOUT VALIDATION`을 쓸 때는 데이터가 파티션 경계에 맞는다는 사실을 별도로 보장해야 합니다. 검증을 생략한 상태에서 경계 밖 값이 들어가 있으면 이후 논리 오류의 원인이 됩니다. 첫 적용에서는 `WITH VALIDATION`을 사용해 시간이 걸리더라도 경계 위반 여부를 확인하는 편이 안전합니다. 또한 `UPDATE INDEXES`를 붙이면 Global Index를 유효 상태로 유지하지만 작업 시간과 로그 발생량이 늘 수 있다는 점은 반드시 사전 점검 항목에 두세요.

### Interval 파티션과 자동 생성 파티션의 이름

Interval 파티션이 만든 파티션은 이름이 `SYS_P`로 시작합니다. 운영 스크립트가 파티션 이름을 하드코딩하면 다음 달부터 실패합니다. 대신 경계값이나 `PARTITION FOR` 문법을 사용하세요.

```sql
-- 이름을 몰라도 특정 날짜가 속한 파티션을 지정할 수 있음
ALTER TABLE orders_i DROP PARTITION FOR (DATE '2026-01-15');

-- 조회도 같은 방식 지원
SELECT COUNT(*) FROM orders_i PARTITION FOR (DATE '2026-02-10');
```

`PARTITION FOR (값)`은 그 값이 속하는 파티션을 가리키므로 이름이 달라져도 스크립트가 유지됩니다. 필요하면 `ALTER TABLE ... RENAME PARTITION`으로 이름을 정리하는 절차도 둘 수 있습니다. 단, Interval 파티션 테이블에서 이미 자동 생성된 마지막 파티션 이후의 구간은 삭제 대상으로 쓸 수 없는 등 제약이 있으므로, 구체적인 제한은 문서에서 확인해야 합니다.

## Hash와 List 파티션을 쓰는 상황

### Hash 파티션

Hash 파티션은 키 값을 해시 함수에 넣어 어느 파티션에 보낼지 결정합니다. 장점은 데이터가 고르게 퍼진다는 점입니다. 다만 범위 조건에서는 프루닝이 되지 않고, 특정 값 조회(`=`)에서만 하나의 파티션으로 좁혀집니다. 파티션 수는 보통 2의 거듭제곱으로 두어야 균등성이 좋다고 알려져 있으므로 문서의 권장 사항을 따르세요.

```sql
CREATE TABLE sessions_h (
  session_id  NUMBER NOT NULL,
  user_id     NUMBER NOT NULL,
  started_at  DATE   NOT NULL
)
PARTITION BY HASH (user_id) PARTITIONS 8;
```

이 구조는 특정 `user_id`의 세션을 조회하면 하나의 파티션만 읽는 데는 유용하지만, "어제 시작한 세션"처럼 시간 조건으로는 모든 파티션을 읽게 됩니다. 업무가 어느 쪽을 요구하는지가 선택 기준입니다.

### List 파티션

List 파티션은 값 목록으로 나눕니다. 지역·국가·고객 등급처럼 값의 집합이 명확할 때 적합합니다.

```sql
CREATE TABLE branch_sales (
  sale_id    NUMBER NOT NULL,
  region     VARCHAR2(10) NOT NULL,
  sale_date  DATE NOT NULL,
  amount     NUMBER(12,2)
)
PARTITION BY LIST (region)
(
  PARTITION p_seoul  VALUES ('SEOUL'),
  PARTITION p_busan  VALUES ('BUSAN'),
  PARTITION p_others VALUES (DEFAULT)
);
```

`DEFAULT` 파티션은 어느 목록에도 없는 값을 받습니다. 새 지역이 추가될 때 `DEFAULT`에 데이터가 쌓이도록 두면 나중에 정리하기 어려워지므로, 새 값이 생기는 시점에 파티션을 분할하는 절차를 갖추세요.

### Composite 파티션

두 방식을 조합한 Composite 파티션은 Range-Hash처럼 "월별로 나누고 각 월 안에서 해시로 분산"하는 식으로 쓰입니다. 파티션 수가 곱으로 늘기 때문에 월 24개에 서브파티션 16개라면 384개의 세그먼트를 관리하게 됩니다. 이는 딕셔너리 메타데이터와 통계 관리 부담으로 이어지므로 필요성이 확실한 경우에만 도입하세요.

## 비교: 파티션 방식별 선택 기준

| 질문 | Range/Interval | List | Hash |
| --- | --- | --- | --- |
| 기간으로 지우는가 | 적합 | 보통 부적합 | 부적합 |
| 범위 조회가 많은가 | 적합 | 부적합 | 부적합 |
| 값이 명확한 목록인가 | 부분 적합 | 적합 | 부적합 |
| 균등 분산이 필요한가 | 시간에 따라 쏠림 | 값 분포에 따라 쏠림 | 적합 |
| 자동 확장이 필요한가 | Interval로 가능 | Auto-List(버전 확인) | 파티션 수 고정 |

이 표는 방식을 고르는 출발점일 뿐 결론이 아닙니다. 실제로는 "무엇을 자주 조회하는가"와 "무엇을 한 번에 지우는가" 두 질문의 답이 서로 다른 키를 가리킬 때가 많습니다. 예를 들어 고객 단위로 조회하지만 월 단위로 지운다면 Range-Hash 같은 복합 구조나 Range 파티션에 고객 컬럼 Local Index를 두는 구조를 검토하게 됩니다.

## 성능 영향과 한계 이해하기

### 프루닝만 믿으면 안 되는 경우

파티션 키 조건이 없는 SQL은 모든 파티션을 읽습니다. 예를 들어 고객 번호로만 조회하는 SQL이 월별 파티션 테이블에서 실행되면, Local Index가 파티션 수만큼 탐색됩니다. 파티션이 36개라면 인덱스 구조를 36번 내려가야 하므로, 파티셔닝 전의 단일 인덱스보다 느려질 수도 있습니다. 이 경우에는 고객 번호 기준의 Global Index를 두거나, 조회 SQL에 날짜 범위를 함께 넣도록 애플리케이션을 바꾸는 것이 현실적입니다.

### 파티션 수와 관리 비용

파티션이 많아질수록 통계 수집, 딕셔너리 조회, DDL(구조 변경 명령)의 관리 비용이 늘어납니다. 일 단위 Interval 파티션으로 수년을 보관하면 수천 개의 파티션이 쌓이기 때문에, 정말 일 단위가 필요한지 월 단위로 충분한지를 먼저 검토하세요. 반대로 파티션이 너무 크면 정리 단위가 거칠어집니다. 정답은 보관 정책과 조회 패턴의 교집합에서 나옵니다.

### 행 이동과 파티션 키 변경

파티션 키 값을 `UPDATE`로 바꾸면 행이 다른 파티션으로 이동해야 합니다. 이를 허용하려면 테이블에 `ENABLE ROW MOVEMENT`가 설정되어 있어야 합니다.

```sql
ALTER TABLE orders ENABLE ROW MOVEMENT;

UPDATE orders SET order_date = DATE '2026-04-02' WHERE order_id = 1001;
```

행 이동은 사실상 삭제 후 삽입이므로 ROWID가 바뀌고, 이를 참조하던 외부 시스템이 있다면 영향을 받을 수 있습니다. 애초에 파티션 키가 바뀌는 업무가 드물어야 이 구조가 안정적입니다. 주문 일자처럼 한 번 정해지면 바뀌지 않는 컬럼이 좋은 키입니다.

### 통계 수집과 대용량 파티션

파티션 테이블의 통계는 테이블 전체(global)와 파티션 단위로 나뉩니다. 매번 전체를 다시 수집하면 시간이 오래 걸리므로, 변경된 파티션 위주로 수집하는 방법이 있습니다. 증분 통계(incremental statistics)와 같은 기능은 별도의 설정과 제약이 따르므로 문서를 확인한 뒤 적용하세요. 통계 자체는 이 블로그의 Oracle 옵티마이저 통계 글에서 다룬 개념을 그대로 적용할 수 있습니다.

## 도입 절차: 기존 테이블을 파티션으로 바꾸기

### 단계별 접근

이미 운영 중인 큰 테이블을 파티션 테이블로 전환하는 방법은 여러 가지입니다. 새 파티션 테이블을 만들어 데이터를 옮기는 방법, 온라인 재정의(DBMS_REDEFINITION)를 사용하는 방법, 버전에 따라 제공되는 온라인 변환 문법을 쓰는 방법 등이 있습니다. 어떤 방법이든 다음 절차는 공통입니다.

1. 조회 SQL을 수집해 파티션 키 후보와 자주 쓰는 조건을 정리합니다.
2. 보관 기간과 삭제 단위를 업무 담당자와 합의합니다.
3. 테스트 환경에서 파티션 구조를 만들고 대표 SQL의 실행 계획을 비교합니다.
4. 유일 제약과 외래 키가 새 구조에서도 유지되는지 검증합니다.
5. 전환 방식과 중단 허용 시간을 정하고, 롤백 절차를 문서로 남깁니다.
6. 전환 후 통계·인덱스 상태·애플리케이션 오류를 점검합니다.

### 가상의 검증 계획

예를 들어 `ORDERS`를 월별 Interval 파티션으로 전환한다면 다음처럼 검증 계획을 세울 수 있습니다. 이는 계획 예시이며 직접 수행한 결과가 아닙니다.

| 검증 항목 | 확인 방법 | 통과 기준 예시 |
| --- | --- | --- |
| 행 수 일치 | 전환 전후 `COUNT(*)` 비교 | 동일 |
| 합계 일치 | `SUM(amount)` 월별 비교 | 동일 |
| 대표 SQL 프루닝 | `DBMS_XPLAN`의 Pstart/Pstop | 단일 파티션 |
| 인덱스 유효성 | `USER_INDEXES`, `USER_IND_PARTITIONS` | UNUSABLE 없음 |
| 유일 제약 | 제약 조건 생성 성공 | 오류 없음 |
| 월말 정리 리허설 | EXCHANGE/DROP 소요 시간 기록 | 허용 시간 이내 |

숫자로 비교할 수 없는 항목은 "누가 어떤 화면에서 확인했는가"를 기록하세요. 파티션 전환은 결과가 같다는 사실을 증명하는 것이 먼저이고, 성능 개선은 그다음입니다.

## 운영 점검 쿼리 모음

### 파티션별 크기 확인

```sql
SELECT segment_name, partition_name,
       ROUND(bytes/1024/1024) AS size_mb
FROM   user_segments
WHERE  segment_type = 'TABLE PARTITION'
AND    segment_name = 'ORDERS'
ORDER  BY partition_name;
```

파티션별 크기가 크게 차이 나면 데이터 쏠림이나 이상 적재를 의심할 수 있습니다. 월말에만 몰리는 업무라면 정상일 수도 있으므로, 업무 달력과 함께 해석하세요.

### MAXVALUE 파티션에 데이터가 쌓이는지 확인

```sql
SELECT COUNT(*) AS rows_in_p_max
FROM   orders PARTITION (p_max);
```

이 값이 0이 아니라면 새 기간 파티션을 만드는 절차가 누락되었다는 신호입니다. 알림으로 연결해 두면 좋습니다.

### Interval 파티션 수 증가 추적

```sql
SELECT COUNT(*) AS auto_created
FROM   user_tab_partitions
WHERE  table_name = 'ORDERS_I'
AND    interval = 'YES';
```

자동 생성 파티션 개수를 월 단위로 기록하면 보관 정책에 맞게 줄어드는지 확인할 수 있습니다. 개수가 계속 늘기만 한다면 삭제 절차가 실행되지 않는다는 뜻입니다.

## 업무 규칙과 파티션 설계 연결하기

### 보관 기간이 설계를 결정한다

파티션 키를 정하기 전에 법적·업무적 보관 기간을 먼저 확인해야 합니다. "13개월 보관 후 삭제"라는 정책이 있다면 월 단위 파티션이 자연스럽고, "분기 단위 마감 후 불변"이라는 정책이 있다면 분기 단위 파티션과 읽기 전용 테이블스페이스의 조합이 후보가 됩니다. 이 정책은 개인정보 보존 기간, 회계 기준 같은 외부 요구와 연결되므로 DBA가 혼자 정하지 말고 업무·법무 담당과 합의해야 합니다.

### 읽기 전용과 저장소 계층

오래된 파티션을 읽기 전용 테이블스페이스에 두면 백업 대상에서 제외하는 전략을 쓸 수 있고, 저렴한 저장소로 이동할 수도 있습니다. 이때 `MOVE PARTITION`과 테이블스페이스 설정 변경이 포함됩니다. 이러한 전략은 백업 정책과 맞물리므로, RMAN 백업 설계 글에서 다룬 복구 목표와 함께 검토하세요. 한 번 이동한 파티션을 다시 쓰기 상태로 되돌리는 절차도 미리 정해 두어야 합니다.

### 애플리케이션과의 약속

개발팀과 합의할 사항은 다음과 같습니다. 조회 SQL에는 파티션 키 범위 조건을 포함한다, 파티션 키 컬럼에는 함수를 적용하지 않는다, 파티션 키 값을 변경하는 `UPDATE`는 금지하거나 사전 협의한다, 신규 쿼리는 실행 계획의 Pstart/Pstop을 코드 리뷰에 첨부한다 등입니다. 이런 약속이 없으면 파티셔닝을 했는데도 일부 화면만 전체 파티션을 읽는 문제가 반복됩니다.

## 파티션 도입 후 첫 한 달의 점검 흐름

파티션 구조를 바꾼 직후에는 기능이 정상이어도 운영 습관이 바뀌지 않아 문제가 생기기 쉽습니다. 첫 달에는 매주 같은 순서로 점검하는 흐름을 만들어 두면 좋습니다. 먼저 `MAXVALUE` 파티션에 행이 쌓였는지, Interval 파티션이 예상대로 하나씩 늘었는지를 확인합니다. 다음으로 대표 SQL 몇 개의 실행 계획에서 `Pstart`와 `Pstop`이 기대한 범위인지 다시 봅니다. 새 배포로 SQL이 바뀌면 프루닝이 깨질 수 있으므로, 배포 직후에 한 번씩 확인하는 편이 좋습니다.

```sql
-- 주간 점검 1: 가장 최근 파티션과 행 수 추세
SELECT partition_name, num_rows, last_analyzed
FROM   user_tab_partitions
WHERE  table_name = 'ORDERS_I'
ORDER  BY partition_position DESC
FETCH FIRST 5 ROWS ONLY;
```

`LAST_ANALYZED`가 오래된 파티션이 있다면 통계가 갱신되지 않았다는 신호입니다. 통계가 오래되면 optimizer가 행 수를 잘못 추정해 프루닝이 되어도 비효율적인 접근 경로를 고를 수 있습니다. 두 번째 주 이후에는 보관 정책에 따른 첫 삭제 작업을 리허설 환경에서 먼저 수행하고, 소요 시간과 인덱스 상태를 기록하세요. 이 기록이 쌓이면 이후 월말 작업의 예상 시간을 근거 있게 말할 수 있고, 작업 시간이 갑자기 늘어났을 때 이상 징후로 알아볼 수 있습니다.

점검 결과는 담당자가 바뀌어도 이어지도록 짧은 운영 기록으로 남기세요. 어떤 파티션을 언제 정리했고, 어떤 SQL의 계획을 확인했으며, 어떤 예외를 승인했는지가 한 장에 있으면 새 담당자도 같은 기준으로 구조를 유지할 수 있습니다.

## 흔한 실수와 회피 방법

| 실수 | 결과 | 회피 방법 |
| --- | --- | --- |
| 파티션 키에 함수 적용 | 프루닝 실패 | 범위 조건으로 풀어서 작성 |
| Global Index를 DROP 후 방치 | 인덱스 UNUSABLE | UPDATE INDEXES 또는 재구성 계획 |
| MAXVALUE에 장기간 적재 | 파티션 이점 상실 | 월간 점검과 SPLIT 절차 |
| 일 단위로 과도하게 분할 | 메타데이터·통계 부담 | 월 단위부터 검토 |
| 자동 생성 이름 하드코딩 | 스크립트 실패 | PARTITION FOR 문법 사용 |
| 검증 없이 EXCHANGE | 경계 위반 데이터 | 첫 적용은 WITH VALIDATION |

이 표의 항목은 모두 "조용히 잘못되는" 유형이라는 공통점이 있습니다. 오류가 나지 않고 느려지거나, 나중에 정리 작업에서 문제를 드러냅니다. 그래서 점검 쿼리를 정기 작업으로 만들어 두는 것이 중요합니다.

## 팀 운영 체크리스트

### 설계 전 질문

- 이 테이블의 가장 중요한 조회 조건은 무엇인가?
- 데이터를 지우거나 이관하는 단위는 무엇인가?
- 유일해야 하는 컬럼은 무엇이며 파티션 키를 포함하는가?
- 파티션 키 값은 입력 후 바뀌는가?
- 사용 중인 에디션에서 Partitioning 옵션이 허용되는가?

### 변경 전 질문

- 영향받는 Global Index와 Local Index는 무엇인가?
- 작업 중 DML(데이터 변경)과 DDL의 잠금 영향은 허용 범위인가?
- 롤백 또는 복구 절차는 문서화되었는가?
- 작업 후 확인할 쿼리는 준비되었는가?

### 변경 후 확인

- 실행 계획의 Pstart/Pstop이 기대한 범위인가?
- 인덱스와 제약이 유효한가?
- 통계가 갱신되었는가?
- 알림과 정기 점검 작업이 새 구조를 반영하는가?

체크리스트는 길수록 좋은 것이 아니라 실제로 쓰이는 것이 좋습니다. 처음에는 위 항목 중 팀에 가장 중요한 다섯 개만 골라 변경 요청서에 넣고, 사고가 나면 항목을 추가하는 방식이 현실적입니다.

<figure class="article-figure"><img src="{{ '/assets/images/oracle-partition-pruning-path.svg' | relative_url }}" alt="SQL의 파티션 키 조건이 optimizer를 거쳐 월별 Range 파티션 중 필요한 파티션만 읽는 구조"><figcaption>그림. 파티션 프루닝은 SQL 조건과 파티션 경계를 비교해 읽지 않을 파티션을 계획 단계에서 제외한다. 이미지 출처: 직접 제작</figcaption></figure>

## 한계와 적용 기준 Q&A

### Q. 파티션 테이블에서 모든 SQL이 빨라지나요?

A. 아닙니다. 파티션 키 조건이 없는 SQL은 모든 파티션을 읽고, Local Index를 쓰는 조회는 파티션 수만큼 인덱스 탐색이 늘 수 있습니다. 파티셔닝은 특정 접근 패턴과 관리 작업에 유리한 구조이며 범용 가속 기능이 아닙니다. 적용 전에 대표 SQL의 실행 계획을 비교해 이득이 있는지 확인하세요.

### Q. 테이블이 몇 건 이상이면 파티셔닝을 해야 하나요?

A. 건수만으로 정하는 기준은 없습니다. 보관 정책이 있어 파티션 단위 삭제가 필요한지, 조회 조건이 키와 맞는지, 유지보수 작업 시간이 허용 범위를 넘는지로 판단하세요. 수천만 건이어도 정리가 필요 없고 인덱스로 충분하다면 파티셔닝은 불필요할 수 있습니다.

### Q. Interval 파티션이면 파티션 관리를 하지 않아도 되나요?

A. 새 파티션 생성은 자동이지만, 오래된 파티션 삭제·이관, 이름 정리, 통계, 저장소 이동은 여전히 운영 절차가 필요합니다. 자동 생성 파티션이 계속 늘어나는 것도 관리 대상입니다.

### Q. Global Index는 피해야 하나요?

A. 피해야 하는 것이 아니라 비용을 알고 선택해야 합니다. 파티션 키 없이 단건을 찾는 조회나 키 단독 유일성이 필요한 경우 Global Index가 필요할 수 있습니다. 대신 파티션 DROP·EXCHANGE 때 인덱스 유지 방식과 작업 시간을 사전 리허설로 확인해야 합니다.

### Q. 라이선스가 없으면 어떻게 하나요?

A. 에디션과 옵션 보유 여부를 먼저 확인하세요. 사용할 수 없다면 테이블을 기간별로 나눈 일반 테이블과 뷰, 또는 보관 테이블로 주기적으로 이동시키는 방식 등을 검토할 수 있으나, 관리 부담과 일관성 문제가 따릅니다. 라이선스 판단은 오라클 계약 담당과 확인해야 합니다.

## 마무리

Oracle Partitioning은 큰 테이블을 쪼개는 도구가 아니라, 읽지 않을 데이터를 계획 단계에서 제외하고 데이터 수명 주기를 파티션 단위 작업으로 바꾸는 도구입니다. 가장 자주 쓰는 조회 조건과 삭제 단위를 먼저 정하고, 그에 맞는 파티션 키와 방식, Local·Global Index를 고르세요. 그다음 `DBMS_XPLAN`의 Pstart·Pstop과 인덱스 상태 쿼리로 기대대로 동작하는지 확인하고, 월간 점검과 보관 절차를 운영 문서에 남기면 파티션 구조가 시간이 지나도 의도대로 유지됩니다.

<h3 class="references-heading">참고 자료</h3>

- [Oracle Database 23ai VLDB and Partitioning Guide](https://docs.oracle.com/en/database/oracle/oracle-database/23/vldbg/)
- [Oracle Database 23ai VLDB and Partitioning Guide: Partitioning Concepts](https://docs.oracle.com/en/database/oracle/oracle-database/23/vldbg/partition-concepts.html)
- [Oracle Database 23ai VLDB and Partitioning Guide: Creating Partitioned Tables and Indexes](https://docs.oracle.com/en/database/oracle/oracle-database/23/vldbg/partition-create-tables-indexes.html)
- [Oracle Database 23ai VLDB and Partitioning Guide: Managing and Maintaining Partitions](https://docs.oracle.com/en/database/oracle/oracle-database/23/vldbg/partition-admin.html)
- [Oracle Database 23ai SQL Language Reference: CREATE TABLE](https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/CREATE-TABLE.html)
