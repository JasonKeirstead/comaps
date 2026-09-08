import SwiftUI

enum Layer: String, Identifiable, CaseIterable {
    case outdoor
    case contourLines
    case buildings3d
    case traffic
    
    
    
    // MARK: Properties
    
    /// The id
    public var id: String {
        return self.rawValue
    }
    
    
    /// The description text
    var description: String {
        switch self {
            case .outdoor:
                return String(localized: "layers_option_outdoor")
            case .contourLines:
                return String(localized: "layers_option_contour-lines")
            case .buildings3d:
                return String(localized: "layers_option_buildings-3d")
            case .traffic:
                return String(localized: "layers_option_traffic")
        }
    }
    
    
    /// The color
    var color: Color {
        switch self {
            case .outdoor:
                return .LayerColors.outdoor
            case .contourLines:
                return .LayerColors.contourLines
            case .buildings3d:
                return .LayerColors.buildings3D
            case .traffic:
                return .LayerColors.traffic
        }
    }
    
    
    /// The image name
    private var imageName: String {
        switch self {
            case .outdoor:
                return "layer.outdoor"
            case .contourLines:
                return "layer.contourlines"
            case .buildings3d:
                return "layer.buildings3d"
            case .traffic:
                // TODO: needs proper layer.traffic.badge.{checkmark,xmark} symbol artwork.
                // Until then badgedImageName falls back to the existing "driving" symbol.
                return "layer.traffic"
        }
    }
    
    
    /// If the layer is currently visible
    var isVisible: Bool {
        get {
            switch self {
                case .outdoor:
                    return MapControls.hasOutdoorLayer
                case .contourLines:
                    return MapControls.hasContourLinesLayer
                case .buildings3d:
                    return MapControls.hasBuildings3dLayer
                case .traffic:
                    return MapControls.hasTrafficLayer
            }
        }
        set(changedIsVisible) {
            switch self {
                case .outdoor:
                    MapControls.hasOutdoorLayer = changedIsVisible
                case .contourLines:
                    MapControls.hasContourLinesLayer = changedIsVisible
                case .buildings3d:
                    MapControls.hasBuildings3dLayer = changedIsVisible
                case .traffic:
                    MapControls.hasTrafficLayer = changedIsVisible
            }
        }
    }
    
    
    /// If the layer is currently disabled for power saving
    var isDisabledForPowerSaving: Bool {
        return self == .buildings3d && Settings.powerSavingBlocksBuildings3dLayer
    }
    
    
    
    // MARK: Methods
    
    /// Receive the badged image name based on the layers current visibility
    /// - Parameter isVisible: If the layer is currently visible
    /// - Parameter isVisible: If the layer is currently visible
    /// - Returns: The badged image name
    func badgedImageName(isVisible: Bool) -> String {
        // No badged artwork exists for traffic yet, and Image(_:) resolves against the asset
        // catalog, so a missing name would render nothing at all. Use the existing driving
        // symbol until layer.traffic.badge.* is drawn.
        if self == .traffic {
            return "driving"
        }
        if isDisabledForPowerSaving {
            return "\(imageName).badge.bolt"
        } else {
            return isVisible ? "\(imageName).badge.checkmark" : "\(imageName).badge.xmark"
        }
    }
}
