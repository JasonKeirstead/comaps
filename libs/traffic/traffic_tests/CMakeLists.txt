project(traffic_tests)

set(SRC traffic_info_test.cpp)

omim_add_test(${PROJECT_NAME} ${SRC} REQUIRE_QT)

# Golden vectors shared with tools/traffic_server so the C++ client and the TypeScript
# self-hosted service cannot drift apart. Passed as a path rather than copied into data/,
# which is shipped with the app.
target_compile_definitions(${PROJECT_NAME}
  PRIVATE
    GOLDEN_TRAFFIC_VECTORS_PATH="${CMAKE_CURRENT_SOURCE_DIR}/golden_traffic_vectors.json"
)

target_link_libraries(${PROJECT_NAME}
  PRIVATE
    indexer
    platform
    platform_tests_support
    traffic
    cppjansson
)
