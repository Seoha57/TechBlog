---
layout: post
title: "Tibero Tablespace와 Datafile을 설계하는 법: 논리 저장소·Undo·Redo·용량과 운영 경계"
date: 2026-10-11 08:30:00 +0900
categories: [dba]
tags: [dba, tibero, tablespace, datafile, undo, redo, capacity, recovery]
description: "Tibero 저장소를 처음 맡는 사람을 위해 tablespace와 datafile의 차이, UNDO·REDO의 역할, 용량 계획과 점검 SQL, 변경과 복구의 운영 경계를 설명합니다."
---

데이터베이스 저장소 문제는 대개 디스크가 꽉 찬 뒤에 발견됩니다. 애플리케이션에서는 갑자기 INSERT가 실패하고, 배치가 중단되고, 운영자는 “파일 시스템은 남았는데 왜 테이블스페이스가 부족한가?”를 확인하게 됩니다. 이때 `ALTER TABLESPACE`를 바로 실행하거나 datafile을 무작정 키우는 것은 좋은 출발이 아닙니다. 먼저 **논리 저장소인 tablespace**, **실제 운영체제 파일인 datafile**, 트랜잭션을 되돌리기 위한 **UNDO**, 장애 복구에 쓰이는 **REDO 로그**가 서로 다른 역할을 한다는 사실을 분리해서 이해해야 합니다.

Tibero에서도 테이블과 인덱스는 tablespace라는 논리 단위에 배치되고, 그 공간은 datafile이라는 물리 파일로 구현됩니다. 하나의 tablespace에 여러 datafile을 둘 수도 있고, 자동 확장(AUTOEXTEND)을 켤 수도 있습니다. 그러나 자동 확장은 파일 시스템 여유·최대 용량·백업 창·장애 시 복구 범위를 대신 판단하지 않습니다. 저장소 설계는 “몇 GB로 만들까”가 아니라 어떤 데이터가 얼마나 빨리 늘고, 어떤 트랜잭션이 오래 유지되며, 장애 때 어느 순서로 복구할지를 정하는 일입니다.

이 글은 Tibero를 처음 운영하는 개발자·DBA·인프라 담당자가 저장 경로를 읽을 수 있게 만드는 데 초점을 둡니다. 특정 환경의 정답 크기나 임의의 초기화 파라미터를 제시하지 않습니다. 대신 업무용 주문 시스템을 예로 들어 datafile과 tablespace를 나누는 기준, UNDO와 REDO를 모니터링하는 이유, 확장과 이동 작업에서 멈춰야 할 지점을 설명합니다.

<section class="quick-answers">
  <p class="quick-label">먼저 답하면</p>
  <div class="quick-answer"><h3>Q. Tablespace와 datafile은 같은 것 아닌가요?</h3><p>A. 아닙니다. tablespace는 객체를 배치하는 논리 저장소이고, datafile은 그 공간을 실제 디스크에 제공하는 파일입니다. 개발자는 테이블을 tablespace에 배치하고, 운영자는 그 tablespace를 구성하는 datafile의 경로·크기·확장 한도를 관리합니다.</p></div>
  <div class="quick-answer"><h3>Q. AUTOEXTEND ON이면 용량 장애를 막을 수 있나요?</h3><p>A. 일시적인 여유를 줄 수는 있지만, maxsize와 파일 시스템 여유가 끝나면 같은 문제가 더 늦게 발생할 뿐입니다. 증가 원인, 최대 한도, 알림 임계값, 확장 절차와 백업 영향까지 같이 정해야 합니다.</p></div>
  <div class="quick-answer"><h3>Q. UNDO와 REDO는 사용자 테이블 데이터를 복제한 파일인가요?</h3><p>A. 둘 다 단순 복제본은 아닙니다. UNDO는 rollback과 일관된 읽기에 필요한 이전 버전 정보를, REDO는 변경을 기록해 장애 복구와 아카이브 기반 복구에 쓰는 로그를 담당합니다. 저장 대상·수명·장애 대응이 다릅니다.</p></div>
</section>

## 먼저 알아둘 기반 기술: 블록·익스텐트·세그먼트·논리와 물리 저장소

데이터베이스는 파일에 행을 한 줄씩 붙이는 프로그램이 아닙니다. 저장과 할당을 관리하기 위해 여러 단위를 겹칩니다. 가장 작은 관리 단위 중 하나인 **data block(데이터 블록)** 은 DBMS가 읽고 쓰는 일정 크기의 공간입니다. 여러 블록을 묶어 한 번에 할당하는 단위를 **extent(익스텐트)** 라고 하고, 테이블이나 인덱스처럼 실제 객체가 차지하는 익스텐트의 집합이 **segment(세그먼트)** 입니다. 세그먼트가 속하는 논리 컨테이너가 **tablespace(테이블스페이스)** 입니다.

이 계층은 “주문 테이블은 80GB, 주문 인덱스는 30GB”라는 업무 언어를 “어느 디스크의 어느 파일이 몇 GB를 제공하는가”라는 운영 언어와 분리합니다. 예를 들어 `ORDER_DATA` tablespace에 주문 본문 테이블을, `ORDER_INDEX` tablespace에 큰 인덱스를 두면 증가 양상과 I/O 특성을 별도로 관찰할 수 있습니다. 다만 이름만 나누고 datafile을 같은 작은 파일 시스템에 몰아두면 물리적인 장애 도메인이나 병목은 분리되지 않습니다. 논리 분리는 목적을 드러내고, 물리 배치는 그 목적을 실제 저장소 정책에 연결합니다.

**datafile(데이터 파일)** 은 permanent 또는 UNDO tablespace가 사용하는 실제 파일입니다. Tibero 공식 Tablespace Management Guide는 tablespace를 테이블과 인덱스를 저장하는 논리 공간으로, datafile을 그 물리 공간으로 설명합니다. 임시 정렬 등에 쓰이는 temporary tablespace는 일반적으로 tempfile을 사용하므로 permanent datafile과 같은 방식으로 백업·복구를 가정하면 안 됩니다. `SYSTEM`처럼 데이터 사전이 있는 시스템 영역과 업무 데이터 영역도 같은 위험도로 다뤄서는 안 됩니다.

여기서 자주 생기는 오해는 “tablespace 사용률” 하나만 보면 된다는 생각입니다. 운영 의사결정에는 최소 네 가지 숫자가 필요합니다. 현재 datafile 총 크기, tablespace 내부의 사용 가능 공간, autoextend가 켜진 경우 maxsize까지 남은 확장 가능량, 그리고 해당 경로의 운영체제 파일 시스템 여유입니다. 첫 세 숫자가 좋아도 파일 시스템이 가득 차면 확장은 실패합니다. 반대로 tablespace 내부 free space가 낮아도 maxsize와 파일 시스템 여유가 충분하며 증가가 예측 가능하면 계획된 확장으로 처리할 수 있습니다.

## Tibero에서 저장소를 역할별로 읽는 법

Tibero 설치 후에는 SYSTEM, UNDO, SYSSUB, USR, TEMP, REDOLOG 등 시스템 운영에 필요한 구성 요소가 기본적으로 존재할 수 있습니다. 그러나 이름이 있다는 사실보다 역할을 이해하는 편이 중요합니다. `SYSTEM`은 데이터 사전 같은 핵심 메타데이터와 연결되므로 일반 업무 테이블의 임시 적재 장소로 쓰지 않습니다. `USR`은 기본 사용자 tablespace일 수 있지만, 운영 환경에서는 애플리케이션별 기본 tablespace를 명시해 의도하지 않은 객체가 한곳으로 쌓이지 않게 하는 편이 낫습니다.

업무용 tablespace는 보통 다음 질문으로 나눕니다. 첫째, 수명 주기가 같은가? 월별 파티션으로 쌓이고 보관 정책으로 삭제되는 주문 이력은 참조성 마스터 데이터와 증감 방식이 다릅니다. 둘째, 백업·복구 또는 이동 작업을 별도로 계획할 이유가 있는가? 셋째, 인덱스 재작성이나 대량 적재처럼 일시적 공간 사용 패턴이 다른가? 넷째, 접근 권한이나 암호화 정책이 다른가? 이 질문에 “예”가 있다면 tablespace 분리가 합리적일 수 있습니다.

반대로 테이블마다 tablespace를 하나씩 만드는 것은 관리 비용만 늘릴 수 있습니다. datafile 수, 알림 대상, 백업 목록, 권한 설정, 장애 절차가 모두 증가합니다. 작은 서비스라면 `APP_DATA`, `APP_INDEX`, `BATCH_STAGE`처럼 목적이 다른 몇 개의 영역부터 시작해도 충분합니다. 분리의 목적을 문서로 설명할 수 없으면 분리하지 않는 것이 더 안전한 기본값입니다.

다음 SQL은 저장소 구조를 읽기 위한 예시입니다. 뷰·컬럼은 사용 중인 Tibero 버전과 권한에서 확인하고, 운영 반영 전에는 해당 버전의 매뉴얼을 우선해야 합니다.

```sql
-- tablespace의 성격과 상태를 먼저 확인한다.
SELECT tablespace_name,
       contents,
       status,
       extent_management
  FROM dba_tablespaces
 ORDER BY tablespace_name;

-- permanent/UNDO datafile의 현재 크기, 최대 크기, 자동 확장 상태를 함께 본다.
SELECT tablespace_name,
       file_name,
       bytes / 1024 / 1024 AS size_mb,
       maxbytes / 1024 / 1024 AS maxsize_mb,
       autoextensible
  FROM dba_data_files
 ORDER BY tablespace_name, file_name;

-- temporary tablespace는 별도 뷰로 확인한다.
SELECT tablespace_name,
       file_name,
       bytes / 1024 / 1024 AS size_mb,
       autoextensible
  FROM dba_temp_files
 ORDER BY tablespace_name, file_name;
```

이 결과는 경보의 출발점이지 결론이 아닙니다. 예를 들어 `AUTOEXTENSIBLE=YES`인 datafile이 있어도 `MAXBYTES`가 현재 값과 같을 수 있고, OS 경로가 모두 같은 볼륨일 수 있습니다. 파일 이름에 `/data01`이 포함됐다는 사실만으로 서로 다른 물리 디스크라고 가정하지 말고, 인프라 담당자와 실제 mount·스토리지 정책을 확인해야 합니다.

## UNDO: 커밋 이전을 되돌리고 일관된 읽기를 지키는 공간

**UNDO** 는 변경 전 값을 기록해 rollback, 읽기 일관성, 일부 복구 기능에 필요한 정보를 제공하는 저장 영역입니다. 트랜잭션이 `UPDATE account SET balance = ...`를 수행한 뒤 아직 commit하지 않았다면 취소할 수 있어야 합니다. 또한 다른 세션이 진행 중인 변경 때문에 중간 상태를 보지 않도록, 특정 시점에 맞는 이전 버전을 읽을 수 있어야 합니다. 이 역할 때문에 UNDO는 “실패한 작업만 쓸 공간”이 아니라 정상적인 동시성 제어의 일부입니다.

업무에서 UNDO 압박은 종종 대량 UPDATE, 긴 배치 트랜잭션, 오래 열린 조회, 인덱스나 데이터 이관 작업과 함께 나타납니다. 문제를 “UNDO datafile을 늘리자”로만 끝내면 원인을 놓칠 수 있습니다. 한 번에 수백만 행을 갱신하는 배치를 작은 단위로 commit해도 되는지, 읽기 작업이 불필요하게 긴 트랜잭션을 잡고 있는지, 피크 시간에 대량 DML을 실행하는지부터 확인해야 합니다. 단, 무조건 자주 commit하는 것도 정답은 아닙니다. 업무 원자성—예를 들어 한 주문의 헤더·상세·재고 변경이 함께 성공하거나 실패해야 한다는 조건—을 깨뜨리면 데이터 정합성이 더 큰 비용을 만듭니다.

Tibero의 업그레이드 점검 문서는 사용 중인 UNDO tablespace, 연결된 datafile의 이름·크기·maxsize·AUTOEXTENSIBLE을 확인하도록 안내합니다. 이는 단순 용량 체크가 아니라 이관이나 장애 대응 전에 어느 파일이 UNDO를 제공하는지 알아야 하기 때문입니다. UNDO가 부족하거나 파일 접근에 문제가 생길 때는 사용자 테이블의 여유와 무관하게 트랜잭션 처리에 영향을 줄 수 있습니다.

```sql
-- 현재 사용 중인 UNDO tablespace 이름을 확인한다.
SHOW PARAMETER UNDO_TABLESPACE;

-- UNDO tablespace와 파일의 확장 한도를 확인한다.
SELECT d.tablespace_name,
       d.file_name,
       d.bytes / 1024 / 1024 AS size_mb,
       d.maxbytes / 1024 / 1024 AS maxsize_mb,
       d.autoextensible
  FROM dba_data_files d
 WHERE d.tablespace_name IN (
       SELECT tablespace_name
         FROM dba_tablespaces
        WHERE contents = 'UNDO'
 )
 ORDER BY d.tablespace_name, d.file_name;
```

이 SQL의 결과가 곧바로 확장 명령을 뜻하지는 않습니다. 운영자는 먼저 증가 시각, 실행 중인 배치, longest query, commit 경계, 파일 시스템 여유, 백업 정책을 함께 기록해야 합니다. 그 기록이 있어야 다음 달의 증가량을 추정하고, 애플리케이션 팀과 배치 쪼개기 또는 스케줄 조정을 논의할 수 있습니다.

## REDO: 변경 기록과 복구 경로를 설계하는 로그

**REDO log(리두 로그)** 는 데이터베이스에서 발생한 변경을 기록하는 로그 파일 집합입니다. datafile에는 최종 데이터 블록이 저장되지만, 장애 시에는 마지막 백업 이후의 변경을 재적용해야 할 수 있습니다. REDO와 archive log 정책은 이 변경 경로를 구성합니다. 즉 REDO는 “테이블스페이스가 부족할 때 늘리는 파일”이 아니라, 쓰기량·로그 스위치·아카이브·복구 목표와 함께 관리하는 별도 경로입니다.

Tibero 공식 복구 가이드는 redo log group과 member, `v$log`, `v$logfile`을 사용해 상태와 파일을 점검하는 예시를 제공합니다. 한 group에 여러 member를 두는 구성은 단일 redo member 파일 손상 위험을 줄이는 목적과 관계가 있지만, 모든 member를 같은 장애 도메인에 두면 보호 효과가 제한됩니다. 서로 다른 경로에 둔다는 말 역시 실제로는 같은 물리 디스크·같은 RAID 그룹·같은 스토리지 장애 도메인이 아닌지 확인해야 합니다.

로그 그룹이 너무 작으면 switch와 archive가 지나치게 자주 일어나 I/O와 운영 관찰이 어려워질 수 있습니다. 반대로 근거 없이 크게 잡으면 장애 시 다뤄야 할 단위나 복구 목표와 맞지 않을 수 있습니다. 어떤 크기가 맞는지는 트랜잭션 발생량, 피크 쓰기, archive 완료 시간, 복구 목표 시간(RTO), 보관 공간을 관찰해 결정해야 합니다. “다른 서버가 1GB를 쓰더라”는 설계 근거가 아닙니다.

```sql
-- redo group의 크기·멤버 수·상태를 함께 확인한다.
SELECT l.group#,
       l.bytes / 1024 / 1024 AS size_mb,
       l.members,
       l.archived,
       l.sequence#,
       l.status
  FROM v$log l
 ORDER BY l.group#;

SELECT f.group#,
       f.member,
       f.status_type
  FROM v$logfile f
 ORDER BY f.group#, f.member;
```

여기서 `CURRENT`, `ACTIVE`, `INACTIVE` 같은 상태를 보고 현재 사용 중인 group을 성급하게 삭제하거나 재생성하면 안 됩니다. REDO 변경은 복구 절차와 밀접하므로, 장애가 아닌 계획 변경도 백업 상태·archive·복구 가능성·정확한 제품 버전 문서를 확인한 maintenance window에서 수행해야 합니다. 특히 파일이 운영체제에서 사라진 상황은 단순히 빈 파일을 다시 만드는 문제가 아닐 수 있습니다.

## 용량 계획: 사용률 하나 대신 증가율과 여유 시간을 계산한다

용량 경보를 `사용률 80%` 하나로 고정하면 두 가지 오류가 생깁니다. 1TB tablespace에서 80%는 충분히 오래 버틸 수 있지만, 10GB staging 영역이 매시간 2GB씩 늘면 몇 시간 안에 실패할 수 있습니다. 반대로 월말에만 커졌다가 정리되는 영역은 일시적 사용률만으로 증설을 반복할 수 있습니다. 따라서 용량 계획은 현재 값, 증가율, 정리 주기, 확장 가능량, 필요한 조치 시간을 함께 봐야 합니다.

가장 단순한 계산은 다음과 같습니다.

```text
남은 시간 ≈ (확장 한도까지 남은 공간) / 최근 평균 증가량

예: maxsize까지 120GB가 남고 최근 6시간 평균 증가량이 시간당 8GB라면
    단순 추정 여유 시간은 약 15시간이다.
```

이 계산은 예측 모델이 아니라 알림 우선순위를 정하는 도구입니다. 배치 시작 직전, 월말, 프로모션 시간대처럼 증가율이 바뀌는 구간은 별도 관찰해야 합니다. 또한 `maxsize`까지 120GB가 남았더라도 underlying filesystem에 50GB만 남았으면 실제 확장 가능량은 50GB보다 작습니다. tablespace 정보와 OS 모니터링을 서로 다른 대시보드가 아니라 하나의 운영 판단으로 묶어야 하는 이유입니다.

권장하는 운영 기록에는 다음이 들어갑니다. tablespace 목적과 소유 서비스, datafile 경로와 실제 mount, 초기 크기·next increment·maxsize, 경보 임계값, 평시·피크 증가율, 정리/파티션 보관 정책, 마지막 확장 날짜와 이유, 백업·복구 절차의 담당자가 그것입니다. 이 정보가 있으면 “공간을 더 달라”라는 알림이 “월말 적재로 APP_HISTORY가 하루 18GB씩 증가하며 maxsize까지 2일 남았고, 파티션 purge는 월요일에 예정되어 있다”는 판단 가능한 사건이 됩니다.

## 예시: 주문 서비스의 저장소 경계를 설계한다

가상의 전자상거래 서비스가 있다고 가정하겠습니다. `orders`와 `order_items`는 계속 늘어나며, 결제 상태를 찾는 인덱스도 빠르게 커집니다. 야간 정산은 원본 주문을 읽어 임시 집계를 만들고, 90일이 지난 이벤트는 보관 정책에 따라 삭제하거나 별도 보관소로 옮깁니다. 이 시스템에 모든 객체를 기본 USR tablespace에 넣으면 어떤 용량이 늘었는지, 정산 때문에 필요한 임시 공간인지, 주문 이력 보관이 원인인지 구분하기 어렵습니다.

처음에는 다음처럼 작고 설명 가능한 경계를 둘 수 있습니다.

| 영역 | 목적 | 운영에서 보는 신호 |
| --- | --- | --- |
| `ORDER_DATA` | 주문·주문 상세의 영속 데이터 | 일별 적재량, 파티션 보관·삭제량 |
| `ORDER_INDEX` | 주문 조회 인덱스 | 인덱스 재작성, 적재 시 증가량 |
| `BATCH_STAGE` | 정산 중간 결과 | 배치 시작/종료 후 사용량 회복 여부 |
| `UNDO` | rollback과 일관된 읽기 | 대량 DML, 오래 열린 트랜잭션 |
| `TEMP` | 정렬·해시 등 작업 공간 | 대형 쿼리와 배치 동시 실행 |
| redo log | 변경 기록과 복구 경로 | switch 빈도, archive 지연, member 상태 |

`ORDER_DATA`가 커진다고 해서 곧바로 datafile을 무제한으로 만들지는 않습니다. 먼저 신규 주문의 증가인지, 파티션 purge 실패인지, 인덱스가 실제로 `ORDER_INDEX`가 아니라 data tablespace에 섞여 있는지 확인합니다. `BATCH_STAGE`가 배치 후에도 줄지 않는다면 임시 테이블 정리·작업 실패·보관 정책을 점검하는 편이 물리 증설보다 우선일 수 있습니다. 이런 식으로 “공간 부족”을 서비스 행동과 연결하면 DBMS를 잘 모르는 담당자와도 원인·우선순위를 대화할 수 있습니다.

새 tablespace를 만드는 명령은 버전과 조직 표준에 맞춰 검토해야 합니다. 다음은 문법과 운영 요소를 읽기 위한 예시일 뿐, 절대 경로·크기·MAXSIZE를 복사해 운영에 실행하라는 뜻이 아닙니다.

```sql
CREATE TABLESPACE order_data
  DATAFILE '/dbdata/app/order_data_01.dtf' SIZE 20G
  AUTOEXTEND ON NEXT 1G MAXSIZE 200G
  EXTENT MANAGEMENT LOCAL AUTOALLOCATE;

ALTER USER app_user DEFAULT TABLESPACE order_data;

CREATE TABLE orders (
  order_id        NUMBER       NOT NULL,
  customer_id     NUMBER       NOT NULL,
  ordered_at      DATE         NOT NULL,
  status          VARCHAR(30)  NOT NULL,
  CONSTRAINT pk_orders PRIMARY KEY (order_id)
) TABLESPACE order_data;
```

실행 전에는 경로의 소유권과 mount, autoextend가 사용할 수 있는 실제 여유, backup agent의 포함 규칙, 재해 복구 환경의 동일 경로 요구, 변경 승인과 롤백 계획을 확인합니다. create가 성공한 것이 운영 준비 완료를 의미하지 않습니다.

## 확장·이동·삭제에서 지켜야 할 운영 경계

저장소 변경은 SQL 한 줄이더라도 운영 변경입니다. 새 datafile 추가나 autoextend 조정은 빠르게 보이지만, 잘못된 경로에 파일을 만들면 백업 누락·파일 시스템 고갈·이관 실패로 이어질 수 있습니다. 작업 전에는 정확한 대상 tablespace와 datafile, 현 사용량과 증가 원인, 파일 시스템 여유, 영향받는 서비스, 백업 가능 여부를 확인합니다. 작업 후에는 SQL 뷰와 OS 양쪽에서 파일·크기·상태를 다시 확인하고, 알림 기준도 새 한도에 맞춰 갱신해야 합니다.

datafile 경로 변경은 특히 “파일을 복사했으니 끝”이 아닙니다. Tibero 지원 가이드는 tablespace를 offline으로 전환하고, datafile 경로를 변경한 뒤 online으로 돌리고 controlfile 백업을 수행하는 절차 예시를 제공합니다. 실제 절차는 대상 tablespace 성격, 버전, 고가용성 구성, 백업 도구에 따라 다를 수 있으므로 해당 환경의 승인된 runbook을 우선합니다. SYSTEM·UNDO·현재 사용 중인 redo처럼 핵심 구성 요소는 일반 사용자 tablespace와 동일한 변경 절차를 가정하면 위험합니다.

삭제도 같은 원칙입니다. `DROP TABLESPACE ... INCLUDING CONTENTS AND DATAFILES` 같은 명령은 논리 객체와 물리 파일에 큰 영향을 줄 수 있습니다. 이름이 비슷한 테스트 tablespace를 삭제하는 사고는 되돌리기 어렵습니다. 삭제 전에는 대상 이름, 연결된 datafile, 포함 객체, 최신 백업, 환경 구분, 동료 검토를 체크리스트로 남깁니다. “테스트니까 괜찮다”는 이유로 production과 비슷한 경로를 공유하는 것은 특히 피해야 합니다.

## 장애가 났을 때: 원인 규명과 복구 결정을 분리한다

저장소 오류가 발생했을 때 첫 행동은 데이터를 덮어쓰는 것이 아니라 증거를 보존하고 범위를 파악하는 것입니다. 애플리케이션 오류 시각, Tibero alert/sys log, 파일 시스템 상태, `dba_data_files`와 `v$log` 결과, 최근 DDL과 배치 실행 기록을 모읍니다. datafile이 보이지 않는다고 빈 파일을 즉시 생성하면 기존 controlfile·redo·archive의 관계를 깨뜨릴 수 있습니다. REDO member 문제도 현재 group인지, 다른 member가 정상인지, 아카이브와 백업이 어떤 상태인지에 따라 대응이 달라집니다.

복구 목표도 분명히 해야 합니다. 서비스 재개가 우선인지, 특정 시점까지 데이터 손실 없이 복구해야 하는지, 쓰기 중단을 감수하고 검증할지에 따라 선택이 달라집니다. 이 판단은 DBA 혼자 기술적으로 정할 수 없고 서비스 책임자와 함께 RTO(Recovery Time Objective, 허용 복구 시간)와 RPO(Recovery Point Objective, 허용 데이터 손실 범위)를 기준으로 정해야 합니다. 복구 명령은 이 글의 예제를 복사하지 말고, 해당 Tibero 버전의 복구 가이드와 조직 runbook, 검증된 백업을 기준으로 수행해야 합니다.

정상일 때 한 번은 복구 절차를 격리된 환경에서 검증하는 것이 좋습니다. 백업 파일이 존재하는 것과 그 백업으로 필요한 시점까지 복원할 수 있는 것은 다릅니다. restore 시간, archive log 보관, controlfile 정보, datafile 경로, 애플리케이션 연결 차단과 재개 절차를 실제로 확인하면 “백업 성공”이라는 모호한 신호를 운영 가능한 증거로 바꿀 수 있습니다.

## 매일·매주·변경 전 점검표를 나누는 이유

저장소 점검은 긴 쿼리를 매일 모두 실행하는 일이 아니라, 위험 신호를 발견할 주기를 역할에 맞게 정하는 일입니다. 매일에는 서비스 중단으로 이어질 수 있는 파일 시스템 여유, datafile autoextend 실패, tablespace의 급격한 증가, redo member 이상, archive 목적지 압박을 확인합니다. 매주에는 추세와 정책을 봅니다. 일별 증가량이 지난달보다 달라졌는지, 더 이상 사용하지 않는 staging 영역이 남아 있는지, maxsize가 실제 운영 용량 계획과 맞는지, backup이 새로 추가한 datafile을 포함하는지를 검토합니다. 월별 또는 분기별에는 복구 연습, 보관 정책, 디스크 장애 도메인, 문서화된 runbook을 점검합니다.

이 구분이 필요한 이유는 경보 피로 때문입니다. 모든 사용률이 70%가 됐다고 야간에 사람을 깨우면 정말 긴급한 UNDO·archive·filesystem 오류가 묻힙니다. 반대로 “주간에 볼 일”이라고만 하면 급증하는 batch staging 영역을 놓칠 수 있습니다. 임계값은 고정 숫자보다 조치 가능 시간과 연결합니다. 예를 들어 업무 시간 안에 확장해야 하는 영역, 다음 정기 점검까지 기다려도 되는 영역, 즉시 쓰기를 중단하고 확인해야 하는 영역을 구분합니다.

| 주기 | 확인 대상 | 질문 | 예시 조치 |
| --- | --- | --- | --- |
| 실시간/일간 | OS 여유·autoextend 오류·archive 목적지 | 다음 조치 전 파일이 찰 가능성이 있는가 | 증설 승인, 배치 중지, 장애 절차 시작 |
| 일간 | tablespace 증가율·UNDO/redo 상태 | 어제와 비교해 급격히 변했는가 | 원인 배치와 배포 이력 확인 |
| 주간 | maxsize·미사용 영역·백업 목록 | 현재 한도와 보관 정책이 맞는가 | 경보 기준·보관 작업·용량 계획 수정 |
| 월간/분기 | restore 리허설·runbook·권한 | 실제 복구가 가능한가 | 격리 환경 복구, 절차와 담당자 갱신 |

점검 결과는 “정상”이라는 한 줄보다 관찰 값과 근거를 남기는 편이 좋습니다. 예를 들어 `ORDER_DATA: 62%, 최근 7일 +11GB, maxsize까지 96GB, /dbdata 여유 180GB, 다음 purge 10월 15일`처럼 기록하면 다음 담당자가 경보를 해석할 수 있습니다. 수치를 기록할 때는 SQL이 본 logical size와 운영체제가 본 allocated size·filesystem free가 다를 수 있다는 점도 같이 명시합니다.

## 저장소 문제를 개발·인프라 팀과 같이 푸는 대화법

DBA가 “tablespace가 찬다”고 말하고 개발팀이 “DB를 늘려 달라”고 답하는 사이에는 중요한 정보가 빠지기 쉽습니다. 개발팀은 어떤 기능이 데이터를 만드는지, 보관·삭제 조건이 무엇인지, 배치가 재시도될 때 중복 적재할 가능성이 있는지를 가장 잘 압니다. 인프라 팀은 datafile 경로가 어느 volume과 스토리지 정책을 사용하는지, snapshot·backup·복제에서 어떤 비용이 생기는지, 실제 파일 시스템 확장에 어떤 승인과 시간이 필요한지를 압니다. DBA는 DBMS의 logical allocation과 transaction·recovery 영향을 연결합니다.

그래서 용량 요청에는 다음 정보를 붙이는 것이 좋습니다. 대상 서비스와 tablespace, 현재·최대 size와 OS 여유, 일별·피크 증가율, 급증이 시작된 배포/배치/데이터 이관, 필요한 시점, 최악의 경우 서비스 영향, 임시 완화책과 장기 대책입니다. 예를 들어 “ORDER_DATA가 부족하다”보다 “10월 프로모션 적재로 하루 18GB 증가해 현 maxsize 기준 36시간 뒤 쓰기 실패가 예상된다. archive와 datafile은 서로 다른 mount이며, 임시로 100GB 확장하고 장기적으로 90일 파티션 purge 실패를 수정한다”가 훨씬 검토하기 쉽습니다.

이 대화는 특정 제품에만 해당하지 않습니다. Oracle, PostgreSQL, MySQL/MariaDB, Tibero처럼 DBMS마다 파일·로그·테이블스페이스 표현은 달라도, 논리 사용량과 실제 저장소, 트랜잭션 임시 공간, 복구 로그, 백업·보관 정책을 함께 봐야 한다는 원칙은 같습니다. 제품별 명령을 외우기 전 이 질문 틀을 익히면 낯선 DBMS에서도 무엇을 확인해야 할지 추론할 수 있습니다.

## 변경 작업의 최소 runbook 예시

새 datafile 추가처럼 작아 보이는 변경도 사람과 시스템이 같은 사실을 확인하도록 최소 runbook을 남깁니다. 다음은 제품 명령을 실행하라는 체크리스트가 아니라, 누락하기 쉬운 검증 순서를 보여 주는 예입니다.

1. 변경 목적과 대상 tablespace/datafile, 예상 용량, 영향 서비스와 승인 번호를 기록한다.
2. `dba_data_files`, `dba_tablespaces`, filesystem 상태, backup 포함 여부를 캡처한다.
3. 대상 경로·권한·mount·maxsize와 autoextend 정책이 조직 기준에 맞는지 확인한다.
4. 해당 버전의 Tibero 문서와 내부 runbook으로 정확한 DDL 및 online/offline 요구를 검토한다.
5. 변경 직후 SQL 뷰와 OS 양쪽에서 새 파일·크기·상태를 확인한다.
6. 알림 대상과 capacity 문서를 갱신하고, 실패했을 때 중단/복구할 기준을 기록한다.

이처럼 과정을 나누면, 단순히 “명령은 성공했다”와 “운영 시스템이 의도한 상태다”를 구별할 수 있습니다. 특히 자동화 스크립트를 만들 때는 대상 DB·tablespace를 명시적으로 입력받고, production 여부를 별도로 확인하며, 수행 전후 결과를 로그로 남기는 안전장치를 두는 편이 좋습니다. 저장소 작업은 잘못된 대상에 한 번 실행하는 비용이 매우 크기 때문입니다.

## 처음 맡은 시스템에서 시작하는 조사 순서

기존 Tibero 시스템을 인수받았을 때는 즉시 구조를 바꾸기보다 지도를 먼저 만듭니다. `dba_tablespaces`에서 영역 이름과 성격을, `dba_data_files`와 `dba_temp_files`에서 파일·크기·확장 한도를, `v$log`와 `v$logfile`에서 redo group과 member를 확인합니다. 그 결과를 서버의 mount 목록, 백업 설정, 모니터링 경보와 나란히 놓습니다. 이름이 `DATA01`인 경로가 정말 업무 데이터 전용인지, `ARCH`가 archive log 보관소인지, 테스트와 운영이 같은 volume을 공유하는지 같은 기본 사실을 이 단계에서 확인합니다.

그다음 최근 한 달의 배치·배포·장애 이력을 읽습니다. 파일이 커진 날짜와 대량 적재, 신규 기능, 파티션 보관 실패, 인덱스 작업을 연결하면 단순 사용률 그래프보다 중요한 원인을 찾을 수 있습니다. 이 조사 결과를 바탕으로 가장 위험한 한두 영역에만 경보와 runbook을 먼저 정합니다. 모든 tablespace를 동시에 재설계하려는 계획은 검증 범위가 너무 크고, 현재 잘 동작하는 경로까지 위험하게 만들 수 있습니다.

마지막으로 실제 담당자를 확인합니다. datafile 확장은 DB 권한만으로 끝나지 않고 스토리지·백업·서비스 변경 승인이 함께 필요할 수 있습니다. 어떤 팀이 파일 시스템을 확장하는지, 누가 배치 중단을 결정하는지, 야간 장애 때 어디까지 자동화하고 누가 복구 승인을 하는지를 문서화하면 저장소 경보가 사람을 찾지 못해 방치되는 일을 줄일 수 있습니다.

## 한계와 적용 기준 Q&A

### Q. 모든 테이블과 인덱스를 서로 다른 tablespace에 두면 더 안전한가요?

A. 대개는 아닙니다. 분리는 관찰·보관·성장·권한·I/O 요구가 다른 대상을 구분하기 위한 수단입니다. 객체마다 나누면 datafile 수와 운영 절차가 늘고 백업·이관·알림도 복잡해집니다. 목적을 설명할 수 있는 단위로만 나누고, 실제 물리 경로와 장애 도메인도 함께 설계해야 합니다.

### Q. AUTOEXTEND의 MAXSIZE를 UNLIMITED로 두면 편하지 않나요?

A. 관리 편의는 생기지만 파일 시스템을 예측 없이 소진할 위험이 커집니다. 특히 여러 datafile이 같은 mount를 공유하면 한 서비스의 급증이 다른 데이터베이스나 archive 영역까지 압박할 수 있습니다. 명시적 maxsize, OS 여유 감시, 증가율 기반 경보, 증설 책임자를 두는 편이 운영에 유리합니다.

### Q. UNDO가 부족하면 무조건 트랜잭션을 더 자주 commit해야 하나요?

A. 아닙니다. commit 경계는 데이터 정합성 요구를 먼저 따라야 합니다. 대량 작업을 작은 논리 단위로 나눌 수 있는지, 긴 조회와 배치를 분리할 수 있는지, 불필요한 긴 트랜잭션이 있는지를 검토합니다. 원자성을 깨지 않는 방법이 없다면 workload와 복구·rollback 요구를 근거로 UNDO 용량과 실행 시간을 설계해야 합니다.

### Q. REDO log의 크기와 member 수는 다른 DBMS의 권장값을 그대로 써도 되나요?

A. 안 됩니다. 제품 버전과 로그 모드, 쓰기량, archive 처리량, 복구 목표, 스토리지 구조가 다릅니다. Tibero 공식 문서와 지원 절차를 기준으로 현재 switch·archive·member 상태를 관찰하고, 검증된 변경 창에서 조정해야 합니다. 다른 제품의 숫자는 질문을 만드는 참고일 뿐 설정값의 근거가 아닙니다.

## 마무리

Tibero 저장소 운영의 핵심은 tablespace를 단순한 폴더처럼 보지 않는 데 있습니다. tablespace는 논리적인 업무 경계이고 datafile은 실제 저장소·백업·장애 복구와 만나는 물리 단위입니다. UNDO는 트랜잭션의 되돌림과 읽기 일관성을, REDO는 변경 기록과 복구 경로를 책임집니다. 그러므로 사용률 하나로 증설을 결정하기보다 증가율, maxsize, 파일 시스템 여유, 배치·보관 정책, 백업과 복구 가능성을 같이 읽어야 합니다.

처음에는 `dba_tablespaces`, `dba_data_files`, `dba_temp_files`, `v$log`, `v$logfile`로 현재 구조를 문서화하는 것부터 시작하면 됩니다. 그다음 서비스별 증가 이유와 경보 기준을 연결하고, 확장·이동·삭제는 승인된 절차와 백업 검증을 통해서만 수행합니다. 이 순서를 지키면 “디스크가 찼다”는 긴급 알림을 예측하고 설명하고 복구할 수 있는 운영 신호로 바꿀 수 있습니다.

<h3 class="references-heading">참고 자료</h3>

- [Tibero GTS, Tablespace Management Guide](https://support.tibero.com/hc/en-us/articles/14320812175887-Tablespace-Management-Guide)
- [Tibero Docs, Backup and Recovery](https://docs.tibero.com/technical-guides/topics/administration/backup-and-recovery)
- [Tibero GTS, Beginner's Guide to Tibero Operation](https://support.tibero.com/hc/en-us/articles/14332231158287-Beginner-s-Guide-to-Tibero-Operation-Environment-Variables-Initialization-Parameter-System-files-Instance-Logs-Client-Connection)
- [TiberoStudio Manual, Datafiles](https://docs.tibero.com/tiberostudio/about/dba/tablespace-manager/tablespaces/bottom/datafiles)
- [Tibero GTS, Tibero Datafile Name and Path Change Guide](https://support.tibero.com/hc/en-us/articles/14487998888463-Tibero-Datafile-Name-and-Path-Change-Guide)
