NS_SWIFT_NAME(SettingsBridge)
@interface MWMSettings : NSObject

+ (BOOL)perspectiveViewEnabled;
+ (void)setPerspectiveViewEnabled:(BOOL)perspectiveViewEnabled;

+ (BOOL)autoZoomEnabled;
+ (void)setAutoZoomEnabled:(BOOL)autoZoomEnabled;

+ (BOOL)autoDownloadEnabled;
+ (void)setAutoDownloadEnabled:(BOOL)autoDownloadEnabled;

+ (MWMUnits)measurementUnits;
+ (void)setMeasurementUnits:(MWMUnits)measurementUnits;

+ (BOOL)zoomButtonsEnabled;
+ (void)setZoomButtonsEnabled:(BOOL)zoomButtonsEnabled;

+ (BOOL)showBookmarkLabels;
+ (void)setShowBookmarkLabels:(BOOL)show;

+ (MWMTheme)theme;
+ (void)setTheme:(MWMTheme)theme;

+ (bool)powerManagementBuildings3d;
+ (NSInteger)powerManagement;
+ (void)setPowerManagement:(NSInteger)powerManagement;

+ (BOOL)routingDisclaimerApproved;
+ (void)setRoutingDisclaimerApproved;

+ (NSString *)spotlightLocaleLanguageId;
+ (void)setSpotlightLocaleLanguageId:(NSString *)spotlightLocaleLanguageId;

+ (double)fontScaleFactor;
+ (void)setFontScaleFactor:(double)fontScaleFactor;

+ (NSDictionary<NSString *, NSString *> *)availableMapLanguages;
+ (NSString *)mapLanguageCode;
+ (void)setMapLanguageCode:(NSString *)mapLanguageCode;

+ (int)alternativeMapLanguageHandling;
+ (void)setAlternativeMapLanguageHandling:(int)alternativeMapLanguageHandling;

+ (BOOL)transliteration;
+ (void)setTransliteration:(BOOL)transliteration;

+ (BOOL)isTrackWarningAlertShown;
+ (void)setTrackWarningAlertShown:(BOOL)shown;

+ (NSString *)donateUrl;

/// Self-hosted traffic service. Traffic is off unless a server is configured;
/// see docs/DEPLOY_OWN_TRAFFIC_SERVER.md.
+ (NSString *)trafficServerUrl;
+ (NSString *)trafficApiKey;
/// Stores both values and drops everything cached from the previous server. Pass empty strings
/// to disconnect.
+ (void)setTrafficServerUrl:(NSString *)url apiKey:(NSString *)apiKey;

+ (BOOL)iCLoudSynchronizationEnabled;
+ (void)setICLoudSynchronizationEnabled:(BOOL)iCLoudSyncEnabled;

+ (void)initializeLogging;
+ (BOOL)isFileLoggingEnabled;
+ (void)setFileLoggingEnabled:(BOOL)fileLoggingEnabled;
+ (NSInteger)logFileSize;

@end
