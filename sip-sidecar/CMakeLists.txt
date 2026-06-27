# sip-sidecar/CMakeLists.txt
# MicroSIP 워크스페이스용 네이티브 SIP 데몬(sipd) 빌드.
#
# 사전 준비:
#   1) pjproject 를 코덱 포함해 빌드(정적 라이브러리 권장).
#      - AMR-NB:  opencore-amr
#      - AMR-WB:  opencore-amr(decode) + vo-amrwbenc(encode)
#      - EVS:     3GPP 레퍼런스 코드를 PJMEDIA 커스텀 코덱으로 통합 (별도)
#      config_site.h 예:
#        #define PJMEDIA_HAS_OPENCORE_AMRNB 1
#        #define PJMEDIA_HAS_OPENCORE_AMRWB 1
#   2) nlohmann/json 헤더 확보 (vcpkg: `vcpkg install nlohmann-json`, 또는 단일 헤더 배치)
#
# 빌드(예, Windows + vcpkg):
#   cmake -B build -DPJ_DIR=C:/path/to/pjproject -DCMAKE_TOOLCHAIN_FILE=<vcpkg>/scripts/buildsystems/vcpkg.cmake
#   cmake --build build --config Release
#   -> 결과 바이너리를 sip-sidecar/bin/<plat>/sipd(.exe) 로 복사
#
cmake_minimum_required(VERSION 3.16)
project(sipd CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT DEFINED PJ_DIR)
  message(FATAL_ERROR "PJ_DIR (pjproject 루트) 를 지정하세요: -DPJ_DIR=C:/path/to/pjproject")
endif()

find_package(nlohmann_json CONFIG QUIET)

add_executable(sipd src/sipd.cpp)

# pjproject include / lib (플랫폼·빌드 구성에 맞게 조정 필요)
target_include_directories(sipd PRIVATE
  ${PJ_DIR}/pjlib/include
  ${PJ_DIR}/pjlib-util/include
  ${PJ_DIR}/pjnath/include
  ${PJ_DIR}/pjmedia/include
  ${PJ_DIR}/pjsip/include
)
# pjproject 가 만든 .lib/.a 들을 링크 (이름/경로는 빌드 산출물 기준으로 조정).
# Windows(MSVC) 예시 — lib 디렉터리를 추가하고 pj* 라이브러리 + 시스템 라이브러리 링크.
target_link_directories(sipd PRIVATE ${PJ_DIR}/lib)
if(WIN32)
  target_link_libraries(sipd PRIVATE
    libpjproject  # 통합 lib 사용 시. (분리 빌드면 pjsua2-lib pjsua-lib pjsip-* pjmedia-* pjnath pjlib-util pjlib 등 나열)
    ws2_32 ole32 winmm dsound dxguid)
else()
  target_link_libraries(sipd PRIVATE pjsua2-lib pjsua-lib pjsip-ua pjsip-simple pjsip pjmedia-codec pjmedia pjnath pjlib-util pj pthread)
endif()

if(TARGET nlohmann_json::nlohmann_json)
  target_link_libraries(sipd PRIVATE nlohmann_json::nlohmann_json)
endif()
